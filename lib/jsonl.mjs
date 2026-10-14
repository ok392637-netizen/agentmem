// ============================================================================
// append-only JSONL 的两个小工具：安全追加一行、找一个 id 有没有**完整**地写进去过。
//
// 为什么单独成文件：memo.mjs 的 add/forget 和 scribe.mjs 的 review 都往同一批 log/<agent>.jsonl
// 里追加，规则必须一致。add 刻意不拿任何锁（它被 agent 高频调用，绝不能被一个跑几分钟的
// review 挡住），所以「半截行」这种状态是真实存在的，两边都得认。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

// 追加一条记录，**前后都带换行**：`\n{...}\n`。
//
// 为什么无条件在前面也加一个换行：文件尾可能是半截行（别人写到一半被杀、断电），新记录要是接在它
// 后面，两条一起变成解析不了的垃圾（Codex 第三轮复核指出）。
// 上一版是「先看文件尾，是半截行才补换行」—— 第五轮复核实测打穿：看完是正常换行，**之后**不拿锁的
// `memo add` 恰好写了半行就被杀，我的记录接在那半行后面，整行解析不了，记录丢失（如果是 review，
// 接着还会删掉候选）。我当时只推演了「两边都先看到半截尾」，漏了「看完之后才出现」。
// 不看就没有「看完之后」：每条记录自带前导换行，不管之前是什么都从新的一行开始。
// 代价是记录之间多一个空行 —— completeLines 和 idInLogs 都不认空行，没有别的影响。
// 不加锁。前导换行管的是「别人在我之前留下的半截行」；而我自己这一次追加**不保证**是一个连续的块
// （Node 遇到短写会分几次写，中间能插进别人的写入，见下面的 appendVerified）—— 那种情况靠回读确认兜住。
// 半截行本身留着：它是「当时发生过什么」的唯一痕迹，索引会跳过它（解析不了）。
export function appendRecord(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `\n${JSON.stringify(rec)}\n`, 'utf8');
}

// log/ 下任何一个文件里，有没有一行**能完整解析**且 id 等于它。
//
// ⚠️ 必须解析，不能查子串。原来查 `"id":"<uuid>"` 子串，Codex 第三轮复核注入了一个只写了
//    `{"id":"<uuid>",` 的半截行 —— 子串照样命中，review 判「已进库」、删掉了完整的候选，
//    而 log 里那半行谁也解析不了：候选彻底丢了。
// 扫整个 log/ 而不是只看 `${agent}.jsonl`：文件名和 agent 名不总是一一对应
// （迁移进来的旧记忆，agent 是 `legacy:claude-memo`，文件却叫 `legacy_claude-memo.jsonl`）。
// 读失败（ENOENT 以外）**直接抛**：读不了就判断不了，判断不了就不能接着提交 ——
// 原来吞掉读错误当成「没结论」，实测会让同一个 id 进库两次。
export function idInLogs(logDir, id) {
  let names;
  try { names = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl')); } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  for (const f of names) {
    if (idInText(fs.readFileSync(path.join(logDir, f), 'utf8'), id)) return true;
  }
  return false;
}

// 一个文件里有没有这个 id 的完整记录。文件不存在算没有；别的读失败照样抛。
export function idInFile(file, id) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  return idInText(text, id);
}

function idInText(text, id) {
  if (!text.includes(id)) return false;                     // 绝大多数文件在这一步就跳过
  for (const line of text.split('\n')) {
    if (!line.includes(id)) continue;
    try { if (JSON.parse(line).id === id) return true; } catch { /* 半截行不算 */ }
  }
  return false;
}

// 追加并**回读确认**：确认不到完整记录就再写一次，还不行就抛错。
// 为什么要回读：「一次追加 = 一个连续的块」不保证成立 —— Node 的 appendFileSync 遇到短写会分几次写，
// 中间可能插进别人的追加，这条记录就被拆成两半、谁也解析不了（Codex 第七轮复核用等价模型复现；
// 本机 NTFS 上会不会自然发生没有验证过）。memo add 原来写完就打印「已记录」，这种情况下就是
// 告诉 agent 记上了、其实丢了。返回第几次写成的，调用方据此提示。
// 只回读目标文件，不扫整个 log 目录：别的坏文件不该连累这一次 add。
export function appendVerified(file, rec) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 1 && process.env.AGENTMEM_FAULT === 'add-torn-once') {
      // 读写失败注入（同 lib/scribe.mjs 的 readFault）：第一次只落下半条，模拟被拆开的追加
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `\n${JSON.stringify(rec).slice(0, 40)}`, 'utf8');
    } else {
      appendRecord(file, rec);
    }
    if (idInFile(file, rec.id)) return attempt;
  }
  throw new Error(`写进 ${path.basename(file)} 之后两次回读都没有完整记录 —— 没记上`);
}

// 取完整的行。并发的 add 正写到一半时，文件尾是半截行 —— 原来 syncIndex 会把它数进「已索引行数」，
// 等那一行写完，它就再也不会被索引了（Codex 第三轮复核复现）。
// 文件尾没有换行、但**能完整解析**的那一行也算：JSON 对象的前缀不可能是合法 JSON，能解析就是写全了，
// 只差最后那个换行（写到换行之前被杀）。不算它的话，idInLogs 说「已进库」、索引却永远看不见它，
// 两边对「完整」的定义不一致（Codex 第四轮复核指出）。现在两边都是「能解析 = 完整」。
export function completeLines(text) {
  const cut = text.lastIndexOf('\n') + 1;
  const lines = text.slice(0, cut).split('\n').filter((l) => l.trim());
  const tail = text.slice(cut);
  if (tail.trim()) {
    try { JSON.parse(tail); lines.push(tail); } catch { /* 半截行：等它写完再算 */ }
  }
  return lines;
}
