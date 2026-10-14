// SPEC.md §7 六条验收，全部走真实 CLI 子进程，用临时 AGENTMEM_HOME。
import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
// 按脚本自己的位置推算仓库：原来写死成主仓库的路径，在 worktree / 副本里跑时测的其实是主仓库的代码
const REPO = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO, 'bin', 'memo.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmem-test-'));
// 模型缓存指向机器上那一份 —— 临时 HOME 每次都是空的，跟着它走会每跑一次验收重下 130MB 模型。
const env = (agent, extra = {}) => ({
  ...process.env, AGENTMEM_HOME: HOME, AGENTMEM_AGENT: agent,
  AGENTMEM_MODEL_CACHE: 'C:/Users/bokily/.agentmem/model-cache', ...extra,
});

const results = [];
const ok = (n, pass, detail) => { results.push({ n, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}\n      ${detail}`); };

function cli(agent, args, opts = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: env(agent), encoding: 'utf8', cwd: opts.cwd || REPO, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// ---- 1. 两个 agent 并发各写 50 条，文件完整无交叉污染
const writes = [];
for (let i = 0; i < 50; i++) {
  writes.push(run(process.execPath, [CLI, 'add', '--title', `甲方记录第${i}条 语义检索`], { env: env('alpha'), cwd: REPO }));
  writes.push(run(process.execPath, [CLI, 'add', '--title', `乙方记录第${i}条 部署流程`], { env: env('beta'), cwd: REPO }));
}
await Promise.all(writes);
const countLines = (f) => fs.readFileSync(path.join(HOME, 'log', f), 'utf8').split('\n').filter(Boolean).length;
const aLines = countLines('alpha.jsonl');
const bLines = countLines('beta.jsonl');
const aClean = fs.readFileSync(path.join(HOME, 'log', 'alpha.jsonl'), 'utf8')
  .split('\n').filter(Boolean).every(l => JSON.parse(l).agent === 'alpha');
const bClean = fs.readFileSync(path.join(HOME, 'log', 'beta.jsonl'), 'utf8')
  .split('\n').filter(Boolean).every(l => JSON.parse(l).agent === 'beta');
ok('1 并发写不交叉污染', aLines === 50 && bLines === 50 && aClean && bClean,
  `alpha=${aLines} 行 beta=${bLines} 行，归属纯净 alpha=${aClean} beta=${bClean}`);

// ---- 2. 3 字符中文命中；2 字符中文也命中（LIKE 兜底）
const r3 = cli('alpha', ['recall', '语义检索']);
const r2 = cli('alpha', ['recall', '部署']);
ok('2 中文检索 ≥3 字符与 <3 字符都命中',
  r3.includes('甲方记录') && r2.includes('乙方记录'),
  `「语义检索」(4字,trigram) ${r3.trim().split('\n').length} 条 · 「部署」(2字,LIKE兜底) ${r2.trim().split('\n').length} 条`);

// ---- 3. 删索引后 reindex，结果一致
const before = cli('alpha', ['recall', '语义检索', '--limit', '50']).trim();
fs.rmSync(path.join(HOME, 'index.sqlite'), { force: true });
const reidx = cli('alpha', ['reindex']).trim();
const after = cli('alpha', ['recall', '语义检索', '--limit', '50']).trim();
ok('3 删索引后重建结果一致', before === after, `${reidx}；重建前后输出逐字节相同 = ${before === after}`);

// ---- 4. who 的撞车预警与 TTL
const sub = path.join(REPO, 'bin');
cli('beta', ['who'], { cwd: sub });              // beta 在子目录报到
const whoSame = cli('alpha', ['who'], { cwd: REPO });   // alpha 在父目录 → 应撞车
const ttlFile = path.join(HOME, 'presence', 'beta.json');
const stale = JSON.parse(fs.readFileSync(ttlFile, 'utf8'));
stale.ts = new Date(Date.now() - 60 * 60 * 1000).toISOString();  // 造一个 1 小时前的
fs.writeFileSync(ttlFile, JSON.stringify(stale));
const whoStale = cli('alpha', ['who'], { cwd: REPO });
ok('4 撞车预警 + TTL 过滤',
  whoSame.includes('撞车') && whoSame.includes('beta') && !whoStale.includes('beta'),
  `同目录时标出撞车=${whoSame.includes('撞车')}；1 小时前的条目被过滤=${!whoStale.includes('beta')}`);

// ---- 5. 缺身份必须报错退出且不写入
const beforeFiles = fs.readdirSync(path.join(HOME, 'log')).length;
let code = 0; let msg = '';
try {
  execFileSync(process.execPath, [CLI, 'add', '--title', 'x'], {
    env: { ...process.env, AGENTMEM_HOME: HOME, AGENTMEM_AGENT: '' },
    encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (e) { code = e.status; msg = String(e.stderr || '').split('\n')[0]; }
const afterFiles = fs.readdirSync(path.join(HOME, 'log')).length;
ok('5 缺身份报错退出且不写入', code !== 0 && beforeFiles === afterFiles,
  `退出码=${code}，日志文件数不变=${beforeFiles === afterFiles}；${msg.slice(0, 46)}`);

// ---- 6. 迁移幂等
const MIG = path.join(REPO, 'scripts', 'migrate-legacy.mjs');
const SRC = 'D:\\claude-memo\\restored-20260912.sqlite';
const m1 = execFileSync(process.execPath, [MIG, '--db', SRC], { env: env('x'), encoding: 'utf8', cwd: REPO });
const legacyFile = path.join(HOME, 'log', 'legacy_claude-memo.jsonl');
const n1 = fs.readFileSync(legacyFile, 'utf8').split('\n').filter(Boolean).length;
const m2 = execFileSync(process.execPath, [MIG, '--db', SRC], { env: env('x'), encoding: 'utf8', cwd: REPO });
const n2 = fs.readFileSync(legacyFile, 'utf8').split('\n').filter(Boolean).length;
ok('6 迁移幂等', n1 === n2 && n1 > 180, `第一次 ${n1} 条，第二次仍 ${n2} 条；源库只读未改动`);

// ---- 迁移后整体检索
cli('alpha', ['reindex']);
const legacyHit = cli('alpha', ['recall', '孤儿进程']);
console.log(`\n迁移后检索历史记忆「孤儿进程」：\n${legacyHit.split('\n').slice(0, 3).map(s => `      ${s}`).join('\n')}`);

// ---- 7. 精排把相关与无关分开（余弦做不到）
// 实测：余弦相关 0.888–0.911 / 无关 0.859–0.886 **重叠**，所以门槛换成交叉编码器的 logit。
const rrOf = (q) => {
  const out = cli('alpha', ['recall', q, '--limit', '4', '--json']);
  return JSON.parse(out.trim().split('\n').pop() || '[]');
};
// 查询词要对得上这个临时库的语料（合成数据 + 第 6 条迁进来的 189 条历史记忆）。
// 「孤儿进程锁死数据库」在历史记忆里确有其事，上面第 6 条末尾就用它验过能召回。
const hit = rrOf('claude-memo 被孤儿进程锁死了数据库怎么办');
const miss = rrOf('今天天气怎么样啊朋友');
const hitTop = hit.length && typeof hit[0].rr === 'number' ? hit[0].rr : null;
const missMax = Math.max(-99, ...miss.map(r => (typeof r.rr === 'number' ? r.rr : -99)));
ok('7 精排把相关与无关分开', hitTop !== null && hitTop > 0 && missMax <= 0,
  `相关查询 top1 精排 ${hitTop === null ? '(没跑)' : hitTop.toFixed(2)}（应 >0）；`
  + `无关查询最高 ${missMax === -99 ? '(没跑精排)' : missMax.toFixed(2)}（应 ≤0）`);

// ---- 8. 精排不可用时必须降级，不能让 recall 整个失败
// G4 第二问的答案要能被证明：模型拉不到（首次 266MB）、ONNX 崩了、超时，
// 都只该退回纯余弦。把模型名指向一个不存在的仓库来制造这个失败。
let degraded = ''; let crashed = false;
try {
  degraded = execFileSync(process.execPath, [CLI, 'recall', '并发写同一个文件', '--limit', '3'], {
    env: { ...env('alpha'), AGENTMEM_RERANK_MODEL: 'agentmem/definitely-not-a-real-model' },
    encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch { crashed = true; }
ok('8 精排不可用时降级而不是崩', !crashed && degraded.trim().length > 0 && !degraded.includes('·精排'),
  `模型名指向不存在的仓库：recall 仍返回 ${degraded.trim().split('\n').filter(Boolean).length} 条结果，`
  + `且不带精排标记（= 走了纯余弦）`);

// ---- 9. 精排分必须与「同批还有谁」无关
// 逐条算是刻意的，不是没想到可以批量：q8 动态量化的 scale 按整批张量算，
// 打成一批会让同一个 (查询, 条目) 对的分被邻居挪动 —— 实测 0.71 个 logit，
// 而**注入门槛就建在这个分上**，摆动 0.71 等于门槛在抛硬币。
// 这条闸把它钉住：谁为了「优化」把 rerank 改回批量，这里立刻红。
const rrMap = (pool) => {
  const out = execFileSync(process.execPath, [CLI, 'recall', 'claude-memo 被孤儿进程锁死了数据库怎么办', '--limit', '30', '--json'], {
    env: { ...env('alpha'), AGENTMEM_RERANK_POOL: String(pool) },
    encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rows = JSON.parse(out.trim().split('\n').pop() || '[]');
  return new Map(rows.filter(r => typeof r.rr === 'number').map(r => [r.id, r.rr]));
};
const rrSmall = rrMap(6);
const rrBig = rrMap(30);
const shared = [...rrSmall.keys()].filter(id => rrBig.has(id));
const drift = Math.max(0, ...shared.map(id => Math.abs(rrSmall.get(id) - rrBig.get(id))));
ok('9 精排分与批次无关', shared.length >= 3 && drift === 0,
  `池 6 与池 30 共有 ${shared.length} 条，最大分差 ${drift}（必须是 0 —— 分数得是 (查询,条目) 的纯函数）`);

// ---- 10. 索引只认完整的行：别人正写到一半时建索引，那一行写完之后必须还能被索引到
// `memo add` 刻意不拿锁（不能被跑几分钟的 review 挡住），所以「读的那一刻文件尾是半截行」是真实状态。
// Codex 第三轮复核复现：原来把半截行也数进「已索引行数」，等它写完就再也不会被索引了。
const logFile = path.join(HOME, 'log', 'alpha.jsonl');
const late = { id: crypto.randomUUID(), ts: new Date().toISOString(), agent: 'alpha', cwd: '', type: 'note',
  title: '半截行补完之后仍然能被检索到的记录', text: '索引水位只认以换行结尾的完整行', tags: [] };
const whole = `${JSON.stringify(late)}\n`;
fs.appendFileSync(logFile, whole.slice(0, 40), 'utf8');   // 写到一半
cli('alpha', ['recall', '随便查一下触发建索引']);
fs.appendFileSync(logFile, whole.slice(40), 'utf8');      // 写完
const found = cli('alpha', ['recall', '半截行补完之后', '--limit', '3']).includes('半截行补完之后仍然能被检索到');
ok('10 正写到一半时建索引，写完后仍能检索到', found, `补完后检索到=${found}`);

// ---- 11. 文件尾那一行能完整解析、只差最后的换行 —— 它是完整记录，索引必须认
// JSON 对象的前缀不可能是合法 JSON，能解析就是写全了（写到换行之前被杀）。
// Codex 第四轮复核：review 判断「已进库」时认它，索引却不认 —— 两边对「完整」的定义不一致。
const tailRec = { id: crypto.randomUUID(), ts: new Date().toISOString(), agent: 'alpha', cwd: '', type: 'note',
  title: '只差最后一个换行的记录也要能检索到', text: '能完整解析的尾行就是完整记录', tags: [] };
fs.appendFileSync(logFile, JSON.stringify(tailRec), 'utf8');   // 故意不写换行
const found11 = cli('alpha', ['recall', '只差最后一个换行', '--limit', '3']).includes('只差最后一个换行的记录');
ok('11 缺最后换行但能解析的尾行照样进索引', found11, `检索到=${found11}`);

// ---- 12. 追加记录时，别人恰好在「我决定怎么写」和「我真正写」之间留下半截行 —— 我的记录也必须完整
// Codex 第五轮复核实测打穿的上一版：先看文件尾、是换行就直接写；看完之后不拿锁的 `memo add`
// 写了半行被杀，我的记录接在后面，整行解析不了。这里在同一个进程里替换 fs.appendFileSync，
// 在真正写之前先插进去一段半截行，模拟那一瞬间。
const { appendRecord } = await import(pathToFileURL(path.join(REPO, 'lib', 'jsonl.mjs')).href);
const raceFile = path.join(HOME, 'race.jsonl');
fs.writeFileSync(raceFile, `${JSON.stringify({ id: 'before' })}\n`, 'utf8');
const realAppend = fs.appendFileSync;
fs.appendFileSync = function injected(p, data, ...rest) {
  fs.appendFileSync = realAppend;                                    // 只插这一次
  realAppend.call(fs, p, '{"id":"half-written-by-someone', 'utf8');  // 别人写到一半被杀
  return realAppend.call(fs, p, data, ...rest);
};
try { appendRecord(raceFile, { id: 'mine', text: '必须完整' }); } finally { fs.appendFileSync = realAppend; }
const mine = fs.readFileSync(raceFile, 'utf8').split('\n')
  .some((l) => { try { return JSON.parse(l).id === 'mine'; } catch { return false; } });
ok('12 追加时别人刚好留下半截行，新记录仍完整', mine, `新记录能完整解析=${mine}`);

// ---- 13. memo add 第一次被拆开写坏了，必须自己发现并重写 —— 不能打印「已记录」其实没记上
// Node 的 appendFileSync 遇到短写会分几次写，中间可能插进别人的追加（Codex 第七轮复核）。
// AGENTMEM_FAULT=add-torn-once 让第一次只落下半条。
let out13 = ''; let code13 = 0;
try {
  out13 = execFileSync(process.execPath, [CLI, 'add', '--title', '第一次被拆开也要记上'], {
    env: { ...env('alpha'), AGENTMEM_FAULT: 'add-torn-once' }, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (e) { code13 = e.status; }
const id13 = (out13.match(/已记录 ([0-9a-f-]{36})/) || [])[1];
const whole13 = id13 ? fs.readFileSync(logFile, 'utf8').split('\n')
  .filter((l) => { try { return JSON.parse(l).id === id13; } catch { return false; } }).length : 0;
ok('13 add 第一次被拆开时自己重写，完整记录正好一条', code13 === 0 && !!id13 && whole13 === 1,
  `退出码 ${code13}；打印了「已记录」=${!!id13}；完整记录 ${whole13} 条（应为 1）`);

console.log(`\n=== ${results.filter(r => r.pass).length}/${results.length} 通过 ===`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(results.every(r => r.pass) ? 0 : 1);
