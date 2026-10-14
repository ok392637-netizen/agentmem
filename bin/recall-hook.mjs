#!/usr/bin/env node
// ============================================================================
// 自动唤起：挂 UserPromptSubmit，把相关记忆注入上下文。
//
// **「查询词从哪来」的答案是：用户的 prompt 本身。**
// 之前卡在这里是因为只想到 SessionStart —— 那时确实不知道用户要干什么。
// UserPromptSubmit 拿得到刚输入的那句话，它天然就是查询词。
//
// 三条约束，都是实测定的：
//
// 1) **每会话只召回一次。** 一次 recall 要 ~1 秒，其中 611ms 是加载 e5 模型
//    （查询本身只要 7ms）。每轮都查会让每次回车都卡一下，用不了几天就会被关掉。
//    而 CLAUDE.md 自己的纪律早就写了「任务开始时召回一次，同一任务内不重复召回」——
//    一个会话付一次 1 秒，完全可以接受。
//
// 2) **门槛看余弦，不能看 RRF 分数。** RRF 只由排名决定，首条恒为 1/(60+0)=0.01667；
//    实测「今天天气怎么样」和真问题的首条分数**一模一样**。拿它当门槛等于没门槛，
//    每次都会往上下文里塞东西。只有原始余弦能区分。
//
// 3) **任何异常都静默退出 0。** 这个 hook 挡在用户和模型之间，
//    它出错绝不能影响用户提问 —— 宁可不注入，不可挡路。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.env.AGENTMEM_HOME || path.join(os.homedir(), '.agentmem');
const MARK_DIR = path.join(ROOT, 'recalled');
const CLI = path.join(import.meta.dirname, 'memo.mjs');

// 门槛看**精排分**，不看余弦。
//
// 余弦分不开：实测相关 0.888–0.911 / 无关 0.859–0.886，**重叠**。
// 之前用 0.89 硬卡，边缘条目照样漏进来 —— 「去 GitHub 找成熟方案」这种问题
// 被注入了两条讲本项目接线细节的记忆，完全不相关。
//
// 交叉编码器的 logit 才分得开。`memo recall --json` 里的 rr 就是它；
// rr 为 null = 这次没跑精排（粗筛 top-1 连 0.87 都不到）→ 一律不注入。
//
// ⚠️ **门槛是 2.5，不是 0。**「0 是模型自带的校准点」那句话已被实测推翻（2026-09-28）——
//    当时分数是**打成一批算的**，而 q8 量化下同一对的分会被同批其他条目挪动 0.71 个 logit，
//    于是「帮我改一下这个变量名」两次运行一次判 −2.13 一次判 +0.07。改成逐条算之后分数稳定，
//    在 22 条真查询 + 6 条真闲聊上重新扫门槛：
//
//      >0     保住 10/14 · 漏进 4/6
//      >2.5   保住 10/14 · 漏进 0/6   ← 选用：把漏注入清零，且一条该注入的都没少
//      >3     保住  8/14 · 漏进 0/6   ← 开始有代价了
//
//    ⚠️ 诚实记上限：2.5 落在「最高的假阳 2.42」和「最低的真阳 2.51」之间，
//    **只有 0.09 的余量，而假阳只有 6 个样本** —— 这不是稳的校准，是当前数据下的最优点。
//    可靠的部分只有：好匹配一般 >4，垃圾一般 <2.5，**2.5–4 这一段说不准**。
const RR_MIN = 2.5;
const MIN_PROMPT_CHARS = 12;   // 「好」「继续」「对」这类不查
const MAX_INJECT = 2;
const MARK_TTL_MS = 7 * 24 * 3600 * 1000;

const quit = () => process.exit(0);   // 永远 0：见文件头第 3 条

// 身份：hooks.json 里只能写命令字符串、没法设环境变量，所以走参数。
// 没有默认值这条纪律在这里依然成立 —— 但 recall 是只读的，记错身份不会污染归属，
// 所以这里退而求其次给 claude 兜底，只为让 hook 永不失败。
const argAgent = (() => {
  const i = process.argv.indexOf('--agent');
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
})();
const AGENT = argAgent || process.env.AGENTMEM_AGENT || 'claude';

let hook = {};
try {
  hook = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  quit();   // 读不到/解析不了 hook 输入就当没这回事
}

const prompt = String(hook.prompt || '').trim();
const sid = String(hook.session_id || hook.sessionId || '').trim();

// 诊断日志：hook 到底有没有被调、被谁调、拿到了什么。
// 没有这行就只能靠副作用反推「它是不是跑了」，实测为此绕了很久。
try {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.appendFileSync(path.join(ROOT, 'recall.log'),
    `${new Date().toISOString()}  sid=${sid || '(无)'}  len=${prompt.length}  ${prompt.slice(0, 60).replace(/\s+/g, ' ')}\n`, 'utf8');
} catch { /* 日志写不了也不能挡路 */ }

if (prompt.length < MIN_PROMPT_CHARS) quit();

// ---- 防自我触发
// scribe/review 是用 `claude -p` 和 dsh 调模型的，而那两个 CLI 会**照常触发
// 自己的 UserPromptSubmit hook** —— 于是记忆系统给自己做召回：
// 每次 scribe 都白加载一次 e5 模型（~1 秒），还把 scribe 的 prompt 当成用户提问
// 写进会话标记。实测抓到过：标记文件里躺着「你是记忆记录员。判断下面这段…」。
// 注入的上下文块自己也会再经过一次，一并挡掉。
const SELF = ['【相关记忆', '你是记忆记录员', '你是记忆审核员', '你刚才给的引证'];
if (SELF.some((m) => prompt.startsWith(m))) quit();

try {
  fs.mkdirSync(MARK_DIR, { recursive: true });
  // 顺手扫掉过期标记。没有定时任务，清理就得寄生在有人调用的路径上。
  const now = Date.now();
  for (const f of fs.readdirSync(MARK_DIR)) {
    const p = path.join(MARK_DIR, f);
    try { if (now - fs.statSync(p).mtimeMs > MARK_TTL_MS) fs.rmSync(p, { force: true }); } catch { /* 跳过 */ }
  }

  if (sid) {
    const mark = path.join(MARK_DIR, `${sid.replace(/[^\w-]/g, '_')}.txt`);
    // **先占位再查**：查询要 1 秒，这期间若同一会话又触发一次，
    // 后来者看到标记就走，不会并发跑两次模型。
    try {
      fs.writeFileSync(mark, prompt.slice(0, 200), { flag: 'wx' });
    } catch {
      quit();   // 已存在 = 本会话召回过了
    }
  }

  const out = execFileSync(process.execPath, [CLI, 'recall', prompt, '--limit', '5', '--json'], {
    env: { ...process.env, AGENTMEM_AGENT: AGENT },
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rows = JSON.parse(out.trim().split('\n').pop() || '[]')
    // rr === null 表示压根没跑精排（粗筛就没到线）→ 不注入。
    // 不退回余弦：余弦分不开，退回去等于把刚修掉的问题放回来。
    .filter((r) => typeof r.rr === 'number' && r.rr > RR_MIN)
    .slice(0, MAX_INJECT);
  if (!rows.length) quit();

  const body = rows.map((r) => {
    const when = String(r.ts || '').slice(0, 10);
    const text = String(r.text || '').replace(/\s+/g, ' ').slice(0, 220);
    return `· [${r.agent} ${when}] ${r.title}\n  ${text}`;
  }).join('\n');

  const text = `【相关记忆 —— 来自 agentmem，本会话只注入这一次】\n${body}\n`
    + `（这些是过去踩过的坑/做过的决定，不一定适用当前任务；需要更多用 \`memo recall <词>\`。）`;

  // **不同 agent 的注入契约不一样，形状给错就静默无效。**
  // claude：hookSpecificOutput.additionalContext
  // codex ：systemMessage —— 实测 codex 不认 additionalContext，
  //         oh-my-codex 的 codex-native-hook.js 里就是把前者转成后者才生效的：
  //           derivedSystemMessage = [reason, additionalContext].join('\n\n') → {systemMessage}
  //         给错形状时 hook 照常跑、输出照常打印，模型就是看不到 —— 又一个「失败是绿色的」。
  // codex 两个字段一起给：它对 UserPromptSubmit 是**原样透传**
  //（oh-my-codex 里 additionalContext→systemMessage 的转换只对 PreToolUse 生效，见其
  // sanitizeCodexHookOutput），而单给任一个实测都没注入成功，所以两个都放，哪个认就用哪个。
  const payload = AGENT === 'codex'
    ? { systemMessage: text, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }
    : { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} catch {
  quit();
}
