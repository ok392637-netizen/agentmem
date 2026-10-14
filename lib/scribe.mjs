// ============================================================================
// scribe / review —— 自动记忆的两半。
//
// scribe：扫 agent 自己的会话记录，用**该家族的小模型**判断有没有值得长期记住的事。
// review：把候选交给**环形下一家的模型**审，作者绝不审自己（G3「作者 ≠ 审核者」）。
//
// 三条贯穿全文的取舍：
//
// 1) **通过审核前不进 log。** log/<agent>.jsonl 是「已成立的记忆」，索引直接吃它。
//    候选待在 pending/，被驳回的挪到 rejected/。于是「审核者挂了怎么办」不需要写代码 ——
//    候选就留在 pending，天然 fail-closed。默认放行等于没有审核。
//
// 2) **能用脚本挡的绝不叫模型。** 窗口里没有写操作（没 Edit/Write/exec）就根本不加载模型：
//    「一整天在读代码」这种会话的成本因此是零，而不是每个窗口烧一次额度。
//
// 3) **会腐烂的东西全部外置到 scribes.json。** 模型名一定会变 —— CLAUDE.md 里记着
//    Codex 自更新把 model 静默改回 sol 的前科。所以模型名不写死，且每次运行都打印
//    实际用的那个名字：腐烂必须看得见，不能只在出错时才发现。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { holdLock } from './oslock.mjs';
import { appendRecord, idInLogs, idInFile, completeLines } from './jsonl.mjs';

// 故障注入点：环境变量 AGENTMEM_FAILPOINT 等于这个名字时，进程在这里直接退出。
// 「两次写入之间被杀」这类缺陷只能这样测 —— 测试桩的屏障只能停在模型调用里，
// 停不到「写完 log、还没删候选」这种缝上（Codex 第三轮复核就是靠注入找出它们的）。
// 不设这个变量时只是一次字符串比较。
function failpoint(name) {
  if (process.env.AGENTMEM_FAILPOINT === name) process.exit(86);
}

// 读失败注入：环境变量 AGENTMEM_FAULT 等于这个名字时，在这里抛一个 EIO。
// 「对一个正常文件读出 EIO」在 Windows 上造不出来，只能这样测；用到它的每一处，都是 Codex 第五轮复核
// 注入复现过的丢失或重复路径（原来把读错误吞掉了）。不设这个变量时只是一次字符串比较。
function readFault(site) {
  if (process.env.AGENTMEM_FAULT === site) throw Object.assign(new Error(`注入的读失败（${site}）`), { code: 'EIO' });
}

// 收拾上次发布到一半被杀留下的候选 .tmp（发布的三步见 cmdScribe）：
//   水位已经越过它的窗口终点 → 「存水位」那步做完了，这个窗口不会再被处理 → 补发布，不然这段内容就丢了；
//   能**证明**水位没越过、而且这个窗口一定会被重做 → 删掉，不然就重复了；
//   其余一切（解析不了、元数据不全、源会话不在扫描范围里）→ 判断不了，原样挪成 .corrupt 留给人看。
// 必须在拿到 writer 锁、读完水位之后调用：判断依据就是此刻的水位。
// scanned = 所有 agent 的会话文件（filesOf 的结果）：只有在里面的，窗口才会被重做。
// scribes = 配置，用来认出 dsh 的暂存（它换过切法，要核对坐标版本）。
function reconcileStaged(ROOT, mark, scanned, scribes) {
  const pendDir = path.join(ROOT, 'pending');
  // **读失败一律抛出、整轮不跑**，只有「读出来了但解析不了」才当成写到一半处理。
  // 吞掉读错误的两个后果都被 Codex 第五轮复核注入复现过：
  //   · 列不出目录就跳过对账、接着推进水位 → 以后那个旧 .tmp 被补发布，和重做的那条**重复**；
  //   · 读不了某个 .tmp 就当坏文件删掉 → 它的水位其实已经存过，这个窗口**永久丢失**。
  let names;
  try {
    readFault('reconcile-list');
    names = fs.readdirSync(pendDir).filter((f) => f.endsWith('.json.tmp'));
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw new Error(`对账时列不出 pending（${e.code || e.message}）—— 这一轮不跑`);
  }
  for (const t of names) {
    const p = path.join(pendDir, t);
    let c = null;
    try {
      readFault('reconcile-read');
      c = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw new Error(`对账时读不了 ${t}（${e.code || e.message}）—— 这一轮不跑`);
      // 解析不了：**不知道水位存没存，就不能删。** 上一版的推理是「解析不了 = 写到一半 = 水位一定没存」，
      // Codex 第七轮复核推翻：.tmp 也可能是**写完之后**被损坏（被截断、被人误改），那时水位已经存过，
      // 删掉它这个窗口就永久漏了（注入复现）。挪成 .corrupt 原样留着给人看，不挡这一轮：
      // 真是写到一半的话，水位没存、窗口会被重做；真是写完后坏的，内容还在这个文件里，人能捞回来。
      fs.renameSync(p, `${p}.corrupt`);
      process.stderr.write(`scribe: ${t} 解析不了，已原样挪成 .corrupt（不确定它的水位存没存，不敢删；memo pending 能看到）\n`);
      continue;
    }
    // 能解析但缺提交用的元数据（sourceFile / window）：同样**判断不了提交没提交**，同样不删。
    // 上一版把它和「水位没越过」归到一起删掉了 —— Codex 第八轮复核指出，这和上面那条是同一个原则，只落实了一半。
    // sourceFile 必须非空：第九轮复核注入了 sourceFile=""，它通过了「是字符串」的检查，水位表里查不到 → 当成 0 →
    // 删掉，而那个候选的水位其实存过。window 必须是两个整数、起点小于终点。
    const w = c && c.window;
    const metaOk = !!c && typeof c.sourceFile === 'string' && c.sourceFile !== ''
      && Array.isArray(w) && w.length === 2 && Number.isInteger(w[0]) && Number.isInteger(w[1]) && w[0] >= 0 && w[0] < w[1];
    if (!metaOk) {
      fs.renameSync(p, `${p}.corrupt`);
      process.stderr.write(`scribe: ${t} 缺提交元数据，判断不了提交没提交，已原样挪成 .corrupt\n`);
      continue;
    }
    // dsh 的暂存要带坐标版本（layout: 2）才判得了：旧版暂存没带，它可能是旧切法下的窗口，也可能是 f59455b
    // 在内存里换算之后写的新坐标 —— Codex 第十一轮复核用当时真实落盘的状态复现：旧水位 3、暂存窗口 [0,2] 其实是新坐标，
    // 按旧水位判成「已提交」补发布，换算后又重做一遍 → 同一段两条候选。两种分不出来，只能隔离。
    // 带了 layout 2、而这个会话还挂着没换算的旧水位：同样分不出来（不该出现），也隔离。会话还没有水位的不受影响。
    // 认不出是哪家的（配置里已经没有这个 agent）也隔离：认不出格式，就不知道它的坐标该不该核对 ——
    // Codex 第十二轮复核：从配置里删掉 dsh 之后，它留下的旧暂存绕过了上面的核对、被补发布了。
    const done = mark[c.sourceFile];
    if (!Object.hasOwn(scribes, c.agent) || (scribes[c.agent].format === 'dsh'
      && (c.layout !== 2 || (typeof done === 'number' && mark[LAYOUT]?.[c.sourceFile] !== 2)))) {
      fs.renameSync(p, `${p}.corrupt`);
      process.stderr.write(`scribe: ${t} ${Object.hasOwn(scribes, c.agent) ? '是 dsh 的暂存，坐标版本对不上' : `的作者 ${c.agent} 不在配置里`}`
        + '（判断不了提交没提交），已原样挪成 .corrupt\n');
      continue;
    }
    if (typeof done === 'number' && done >= w[1]) {
      fs.renameSync(p, p.slice(0, -'.tmp'.length));
      process.stdout.write(`  补发布上次没来得及发布的候选：${String(c.title).slice(0, 40)}\n`);
    } else if (scanned.has(c.sourceFile)) {
      // 元数据完整、水位没越过它的窗口终点、源会话还在扫描范围里 —— 这是唯一**能证明**「这个窗口会被重做」的情况，
      // 删掉才不重复。
      fs.rmSync(p, { force: true });
    } else {
      // 水位没越过，可源会话已经不在扫描范围里了（被删了、挪走了、配置改了）：这个窗口再也不会被重做，
      // 删掉就是丢。不发布（它没提交过），也不删。
      fs.renameSync(p, `${p}.corrupt`);
      process.stderr.write(`scribe: ${t} 的源会话不在扫描范围里，窗口不会被重做，已原样挪成 .corrupt\n`);
    }
  }
}

// 把一个窗口切成几段，每段正文不超过 MAX_WINDOW_CHARS，逐段交给模型、逐段存水位。
//
// 原来只把**最后** 24000 字交给模型，水位却越过整个窗口 —— 长时间断线后的积压，前面那部分
// 从来没被看过就被标成看完了（Codex 第七、八轮复核；第八轮实测：恢复前追加超过 24000 字，
// 原来那段内容再也进不了模型）。平时一次会话结束只有几轮新内容，碰不到；可「掉登录」「额度用完」
// 正是会攒出大积压的时候，也正是之前已经出过事的时候。
//
// 输入是窗口里**每一行各自的提取结果**（见 unitsOf），一段的正文就是段内各行的片段用换行拼起来 ——
// 和整窗一起提取时逐字相同，所以段边界切在哪都不改变任何一行的内容。
// 上一版是对行区间反复整体提取、二分找边界，靠的是「提取长度随行数单调」这个假设（Codex 第九轮复核核过
// 三种格式当时都成立，但那是提取器碰巧如此，不是保证），而且反复重解析是平方级的。
//
// 尽量切在「一轮用户提问」的开头：问题和回答分到两段的话，后一段的模型只看得到回答（第九轮复核注入复现）。
// 前提是这一段已经过半，否则一个很长的回答会把段切得很碎。
// 只有单独一行就超过上限时才截断（取尾部），并通过 onTruncate 报出来 —— 截掉的那部分没有人看过。
// 「上限」按 budget 量（见 windowBudget）：一般就是字数；经命令行收提示的模型（dsh）按转义后的长度量，
// 引号、反斜杠多的段会切得更短 —— 否则一段放不进命令行，只能整段送不出去（第十八轮复核 D）。
// 返回 [{ start, end, text }]，start/end 是在整份会话里的行号（[起, 止)）。
function splitChunks(units, base, onTruncate, { max, cost } = windowBudget(null)) {
  const out = [];
  let i = 0;
  while (i < units.length) {
    let len = 0; let j = i; let cut = -1;
    while (j < units.length) {
      const t = units[j].text;
      const add = t ? cost(t) + (len ? 1 : 0) : 0;
      // 没有正文的行（工具调用、去重掉的重复记录）不占地方，永远跟着当前段 —— 否则一行超长之后，
      // 后面紧跟的空行会自成一段，拿一段空正文去叫模型
      if (j > i && add > 0 && len + add > max) break;
      if (j > i && units[j].user && len >= max / 2) cut = j;
      len += add;
      j += 1;
    }
    if (j < units.length && cut > i) j = cut;
    let text = units.slice(i, j).map((u) => u.text).filter(Boolean).join('\n');
    if (cost(text) > max) {
      onTruncate(base + i, text.length);
      text = fitTail(text, max, cost);
    }
    out.push({ start: base + i, end: base + j, text });
    i = j;
  }
  return out;
}

// 窗口里出现这些工具 = 这段会话真的动了东西，才值得叫模型。
const WRITE_TOOLS = new Set([
  'Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell',          // claude
  'apply_patch', 'exec', 'exec_command', 'shell', 'write_file',   // codex
]);

// ⚠️ run 里那个「不落盘」的开关是**必需的，不是优化**。
//
// 没有它时：scribe 每问一次就在用户的会话列表里多一条「你是记忆记录员。判断下面这段…」。
// 实测两天的开发测试就塞进去 26 条 claude 会话 + 约 20 条 codex rollout。
// 更糟的是它会**回流**：那些会话落在 ~/.claude/projects/ 下，正是 scribe 自己要扫的目录，
// 于是记忆系统开始读自己的提问。目前靠「窗口内没有写操作就不叫模型」挡住了，
// 但那是运气不是设计 —— 一旦 scribe 换成会用工具的模型，循环立刻成立。
//
// claude 用 --no-session-persistence，codex 用 --ephemeral。两个都验证过。
// 改 scribes.json 时**不要删掉它们**，`memo scribe` 会拒绝跑没带这些开关的配置。
//
// ⚠️ 另一组同样必需的开关：**不许模型用工具**（见 NO_TOOLS）。
// 2026-10-12 实测事故：scribe 叫的 `claude -p --model haiku` 带着全部工具和 MCP、按用户设置的权限模式跑，
// 读到的会话片段里正好有一份代码复核报告 —— 它就动手改了 agentmem 自己的 lib/scribe.mjs（未经任何人要求）。
// 送进模型的会话片段是**不可信输入**：片段里写什么，带工具的模型就可能去做什么。
// 而调用方的权限设置往往放得很宽（跳过确认 / 完全访问）—— 继承下来就是能写任何文件。
const DEFAULT_SCRIBES = {
  claude: {
    model: 'haiku',
    format: 'claude',
    transcripts: ['~/.claude/projects/*/*.jsonl'],
    run: ['claude.cmd', '-p', '--no-session-persistence', '--model', '{model}',
      '--tools', '', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--disable-slash-commands'],
  },
  codex: {
    model: 'gpt-5.6-luna',
    format: 'codex',
    transcripts: ['~/.codex/sessions/*/*/*/rollout-*.jsonl'],
    // 末尾的 `-` 让 codex 从 stdin 读 prompt。
    // 必须这样：prompt 里有换行和引号，走命令行会被 cmd.exe 撕碎。
    run: ['codex.cmd', 'exec', '--ephemeral', '--skip-git-repo-check', '-m', '{model}',
      '-c', 'model_reasoning_effort=low', '-s', 'read-only', '-'],
  },
  dsh: {
    model: 'deepseek-flash',
    format: 'dsh',
    // dsh 的对话正文不在 sessions/*.zstd 里（那份只有一行 session 头，实测 56 个全是），
    // 在 projcache 这个 JSON 里：首条 prompt 完整，每轮概要被截断，todos 完整。
    transcripts: ['~/.dsh/storages/session_projcache/sessions/*.json'],
    // headless 没有 stdin 也没有任何开关，任务只能当位置参数。{prompt} 由 runModel 替换，
    // 走 argv 不走 shell，换行/引号/& | > < 都原样送达（实测）。
    // ⚠️ 必须绕开 cmd.exe 直接 node 跑 dsh 的入口。
    // 走 `cmd /c dsh.cmd "<多行prompt>"` 时 **prompt 会在第一个换行处被截断**，
    // 而且不报错 —— 模型只收到第一行，然后回复「你的消息到这里就结束了」。
    // （我第一次测是假阳性：测试用的 JSON 正好在第一行，看起来像原样送达。）
    run: ['node',
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '--profile', 'headless', '{prompt}'],
  },
};

// 每个 agent 的「不落盘」开关。少一个就不许跑 —— 这类污染是静默的：
// 它不报错、不变慢，只是在用户的会话列表里越堆越多，等被发现时已经几十条了。
const NO_PERSIST_FLAG = {
  claude: '--no-session-persistence',
  codex: '--ephemeral',
};

// dsh 没有任何「不落盘」开关（`dsh --profile headless --help` 只有 -h，实测）。
// 但它的会话目录是**按 cwd 编码**的 —— `--C-Users-bokily-.agentmem-dsh-sandbox--`。
// 所以给 scribe 的调用指定一个专用 cwd，它的会话就独立成一坨，清理时碰不到用户真实的会话。
// 这是「没有开关就自己造隔离」，不是放弃隔离。
const SANDBOX_CWD = { dsh: path.join(os.homedir(), '.agentmem', 'dsh-sandbox') };

const DSH_SESSIONS = path.join(os.homedir(), '.dsh', 'sessions');
const DSH_PROJCACHE = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');

// 调用前后各拍一次快照，只删「新出现**且** cwd 确实是沙盒」的。
// 两个条件都要：光看「新出现」会在用户同时开着 dsh 时误删他的会话。
function snapshotDsh() {
  const s = new Set();
  for (const d of [DSH_SESSIONS, DSH_PROJCACHE]) {
    try { for (const n of fs.readdirSync(d)) s.add(path.join(d, n)); } catch { /* 没有就算了 */ }
  }
  return s;
}

function cleanupDsh(before, sandbox) {
  const norm = (p) => String(p || '').replace(/[\\/]+/g, '/').toLowerCase();
  const want = norm(sandbox);
  for (const p of snapshotDsh()) {
    if (before.has(p)) continue;                       // 不是这次新增的
    let isOurs = false;
    if (p.startsWith(DSH_PROJCACHE)) {
      try { isOurs = norm(JSON.parse(fs.readFileSync(p, 'utf8')).record.identity.cwd) === want; } catch { /* 读不了就不动 */ }
    } else {
      // dsh 把 cwd 编码进目录名（`--C-Users-bokily-.agentmem-dsh-sandbox--`），
      // 但编码规则没文档。别去猜它怎么替换分隔符 —— 两边都**只留字母数字**再比，
      // 这样点、冒号、斜杠、连字符怎么变都无所谓。
      // （上一版猜成「非字母数字→连字符」，结果 `.agentmem` 的点对不上，清理静默失效。）
      const squash = (x) => x.replace(/[^a-z0-9]+/g, '');
      isOurs = squash(norm(path.basename(p))).includes(squash(want));
    }
    if (isOurs) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 删不掉下次再说 */ } }
  }
}

// AGENTMEM_MODEL_TIMEOUT_MS 只给验收用（测超时熔断不能真等 5 分钟）
const MODEL_TIMEOUT_MS = Number(process.env.AGENTMEM_MODEL_TIMEOUT_MS) > 0 ? Number(process.env.AGENTMEM_MODEL_TIMEOUT_MS) : 5 * 60 * 1000;
const REVIEW_TRIP = 2;            // review 里同一个审核者连续失败几次就本轮不再叫（见 cmdReview）
// 同一个审核者本轮失败累计耗时到这么多也熔断：失败和成功交替时连续计数总被清零，
// 七次超时夹七次成功就是 35 分钟（第十八轮 C），30 分钟的步骤时限先到。
const REVIEW_FAIL_BUDGET_MS = 2 * MODEL_TIMEOUT_MS;
// 一轮 review 过了这么久就不再开始新的模型调用，剩下的原地留到下一轮：
// auto 那一步 30 分钟到点会整个杀掉，宁可自己先停（最后一次调用最多再 5 分钟）。
const REVIEW_BUDGET_MS = Number(process.env.AGENTMEM_REVIEW_BUDGET_MS) >= 0 && process.env.AGENTMEM_REVIEW_BUDGET_MS
  ? Number(process.env.AGENTMEM_REVIEW_BUDGET_MS) : 20 * 60 * 1000;
// 只是「这一条提示」送不出去的错误：不算审核者挂了（见 runModel 的长度检查）
const CANDIDATE_ERRORS = new Set(['PROMPT_TOO_LONG', 'ENAMETOOLONG', 'E2BIG']);
const MAX_WINDOW_CHARS = 24000;   // 一次喂给小模型的上限。超过就切成几段逐段喂，见 splitChunks
const MIN_WINDOW_CHARS = 200;     // 比这还短的窗口没有可记的东西 —— 除非会话已经停住（见 SHORT_FLUSH_IDLE_MS）
// 不足 200 字的窗口先等着攒；会话文件这么久没再写过，就认为它停了，短尾照常送一次。
const SHORT_FLUSH_IDLE_MS = 2 * 60 * 60 * 1000;
// 文件多久没写过。读不到时间就当还在写（不送），但要说出来 —— 不说的话短尾就一声不响地一直停着（Codex 第十二轮复核）。
const idleFor = (f, ms) => {
  try { return Date.now() - fs.statSync(f).mtimeMs > ms; } catch (e) {
    process.stderr.write(`scribe: 读不到 ${path.basename(f)} 的修改时间（${e.code || e.message}），它的短尾这一轮先不送\n`);
    return false;
  }
};
// 每个 agent 一轮最多叫几次模型（各家额度是分开的池，所以按家算）。到了就停在当前段的起点，
// 剩下的下一轮接着做（水位和续做标记都已存好）。
// 没有它时，一次几十万字的积压一轮就要叫几十次模型；再赶上 auto 30 分钟到点把 scribe 杀掉，
// 就是反复付费不推进（Codex 第九轮复核）。20 次 × 每次几十秒，留在 30 分钟以内。
const MAX_CALLS_PER_AGENT = Number(process.env.AGENTMEM_SCRIBE_MAX_CALLS) > 0
  ? Number(process.env.AGENTMEM_SCRIBE_MAX_CALLS) : 20;
// 「已经记过了」的判定线。0.96 是量出来的，不是拍的 ——
// 同一件事换个说法 0.9702 · 共享一半样板 0.9506 · 同领域但不同的事 0.8837 · 跨领域 0.8884。
// e5 对中文的相似度整体偏高（真·无关的两条也有 0.88），所以能用的缝只有 0.89–0.97 这一段，
// 0.96 落在缝中间。原先写 0.95 离误杀只差 0.0006，会把「共享样板但讲不同事」的记忆吃掉。
const DUP_THRESHOLD = 0.96;

const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// ---------------------------------------------------------------- 配置与水位
function loadScribes(ROOT) {
  const f = path.join(ROOT, 'scribes.json');
  if (!fs.existsSync(f)) {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify(DEFAULT_SCRIBES, null, 2)}\n`, 'utf8');
  }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// 启动即校验：run 里少了「不落盘」开关就直接退出，不进循环。
//
// 为什么是**启动时**而不是调用时：放在 runModel 里抛，会被那层「模型调用失败，记一行接着跑」
// 的 catch 吞掉（那层是给 403/超时用的）。结果是 scribe 永远静默地什么都不产出，
// 而你要翻日志才知道为什么 —— 配置错误和运行故障必须走不同的路。
// 每个 agent「不许用工具」要带的参数（按顺序相邻出现）。少一组就不许跑（见 DEFAULT_SCRIBES 上面的事故说明）。
//   claude：--tools "" 关掉全部内置工具，--strict-mcp-config 不加载任何 MCP，--permission-mode dontAsk 兜底（实测：
//           带这几个参数时让它写文件，它只会在回答里「写」出调用，文件不会出现）。
//   codex：只读沙盒（实测：让它用 shell 写文件，返回 wrote:false，文件不存在）。
//   dsh：没有关工具的开关，runModel 用 DSH_PERMISSION_MODE=read-only 强制只读预设（不靠配置）。
const NO_TOOLS = {
  claude: [['--tools', ''], ['--strict-mcp-config'], ['--permission-mode', 'dontAsk']],
  codex: [['-s', 'read-only']],
};
const hasSeq = (argv, seq) => argv.some((_, i) => seq.every((x, k) => argv[i + k] === x));

function assertNoPersist(scribes) {
  const missing = [];
  for (const [agent, spec] of Object.entries(scribes)) {
    const argv = (spec.run || []).map(String);
    // 两种隔离任选其一：CLI 自带「不落盘」开关，或者我们给它造一个沙盒 cwd。
    // 两样都没有 = 这个 agent 的每次提问都会留在用户的会话列表里，不许跑。
    const need = NO_PERSIST_FLAG[agent];
    if (!SANDBOX_CWD[agent] && need && !argv.includes(need)) missing.push(`${agent} 缺 ${need}`);
    for (const seq of NO_TOOLS[agent] || []) {
      // codex 的 -s 也可以写成 --sandbox
      const alt = seq[0] === '-s' ? ['--sandbox', ...seq.slice(1)] : null;
      if (!hasSeq(argv, seq) && !(alt && hasSeq(argv, alt))) missing.push(`${agent} 缺 ${seq.map((x) => (x === '' ? '""' : x)).join(' ')}`);
    }
  }
  if (missing.length) {
    throw new Error(`scribes.json 配置有误：${missing.join('；')}。\n`
      + '  少了「不落盘」开关，scribe 每问一次就在你的会话列表里留一条「你是记忆记录员…」，\n'
      + '  而且那些会话会落进 scribe 自己要扫的目录里，形成回流。\n'
      + '  少了「不许用工具」的参数，模型会对着会话片段里的内容动手（2026-10-12 它改过 agentmem 自己的代码）。\n'
      + `  改 ${'~/.agentmem/scribes.json'} 把它们加回 run 数组。`);
  }
}

const markPath = (ROOT) => path.join(ROOT, 'scribemark.json');

// 水位表里有两个键不是会话文件（'#' 开头，和绝对路径撞不上）：
//   '#continue'  续做：{ 会话文件: 窗口终点 } —— 这个窗口已经过了预筛、还没做完（某段调用失败，或本轮调用到了上限）。
//                下一轮从水位接着做，**不再预筛**。没有它时，剩下的后缀会被当成一个新窗口重新预筛：
//                唯一的写操作在已经做完的前一段里，后缀就被判成「没动过东西」直接越过、从来没送进模型
//                （Codex 第九轮复核注入复现：claude 水位 1→2、codex 2→3，恢复时一次模型都没叫）；后缀不足 200 字时同理。
//   '#layout'    { dsh 会话文件: 2 } —— 这个文件的水位已经是新切法下的行数（见 readDshUnits / migrateDshMarks）。
// 两个都和水位存在同一个文件里、一起原子写：分开存的话，两次写之间被杀，它们就对不上了。
const CONT = '#continue';
const LAYOUT = '#layout';

// dsh 的切法变了（见 readDshUnits），旧水位是旧切法下的行数，不能直接沿用：旧切法每个会话多出首条、待办、
// 动过最多三行，旧水位比新行数大，直接用的话之后新的几轮会被当成「早就看过」。真实水位表里有 87 个 dsh 会话。
//
// 换算一律是「旧水位 − 3，且不超过现在已结束的轮数」：旧水位里最多有 3 行不是轮次（首条、待办、动过），
// 减 3 是「至少看过几轮」的下界 —— 宁可多看两轮（可能多产一条重复候选），不能少看。
// 上一版还有一条「旧水位 ≥ 旧切法下现在的行数 → 全看过了」，Codex 第十轮复核推翻：dsh 每轮开始都会清空待办
// （dsh-tool-todo），[首条, 第1轮, 待办, 动过] 扫完是 4，多一轮、待办清空后变成 [首条, 第1轮, 第2轮, 动过]，还是 4 ——
// 长度没变，第 2 轮却从没看过，那条规则会把它直接越过。现在的长度证明不了当时看过什么。
// 旧缺陷已经吞掉的轮次救不回来：水位越过了它们，换算分不出哪些是真看过的。
//
// **在开扫之前对所有 dsh 会话一次换算完、立刻落盘**（Codex 第十轮复核）：上一版是扫到哪个文件才在内存里换算，
// 换算后暂存了一个新坐标的 .tmp、存水位之前被杀 → 磁盘上还是旧水位、没有换算标记 → 下次对账拿旧坐标的水位
// 去比新坐标的窗口，判错（实测补发布了一条、又重做出一条）。先落盘，之后暂存的 .tmp 和磁盘上的水位就是同一套坐标。
// 读不了的会话这一轮不换算（不打标记），扫描时也跳过它（见 cmdScribe），下一轮再换。
// **只碰已经有旧水位的会话**：没有水位的新会话没有旧坐标，扫描时再打标记。给它们也打标记的话，
// 在还没 --init 的库里这一步就会把水位表写出来 —— auto.mjs 的冷启动联锁看的正是「水位表在不在」，
// 联锁一失效就是全量回扫历史（验收 29g 抓到的）。
function migrateDshMarks(ROOT, mark, scribes) {
  let changed = false;
  for (const spec of Object.values(scribes)) {
    if (spec.format !== 'dsh') continue;
    for (const f of filesOf(spec)) {
      if (mark[LAYOUT]?.[f] === 2 || typeof mark[f] !== 'number') continue;
      let closed;
      try { closed = readDshUnits(f).length; } catch { continue; }
      mark[f] = Math.min(closed, Math.max(0, mark[f] - 3));
      (mark[LAYOUT] ||= {})[f] = 2;
      changed = true;
    }
  }
  if (changed) saveMark(ROOT, mark);
}
// 文件不存在 = 还没建水位，正常。**别的读失败、或者内容坏了，一律抛出、整轮不跑。**
// 原来一律当成空表 —— 对账就会以为所有窗口都没存过水位，把已经提交的候选当成未提交删掉
// （Codex 第五轮复核注入复现：候选永久丢失）。宁可这一轮不跑，也不能拿错的水位去动别的东西。
function loadMark(ROOT) {
  let text;
  try {
    readFault('mark');
    text = fs.readFileSync(markPath(ROOT), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`读不了水位表（${e.code || e.message}）—— 这一轮不跑，免得拿错的水位去删候选`);
  }
  try { return JSON.parse(text); } catch {
    throw new Error('水位表内容坏了，解析不了 —— 这一轮不跑。scribemark.json 需要人看一下');
  }
}
// 先写临时文件再改名（同目录 rename 是原子替换）。直接覆盖写到一半被杀，水位表就是半截 JSON，
// 下次 loadMark 解析失败、当成「全部从 0 开始」—— 冷启动联锁会把整个 scribe 拒掉，
// 联锁没拦住的话就是全量重扫、重复产出（Codex 第二轮复核指出）。
function saveMark(ROOT, m) {
  const p = markPath(ROOT);
  fs.writeFileSync(`${p}.tmp`, `${JSON.stringify(m, null, 1)}\n`, 'utf8');
  fs.renameSync(`${p}.tmp`, p);
}

// 模型调用为什么失败。原因在**子进程自己的 stderr** 里（「Not logged in」「usage limit」「529」…），
// 而 execFileSync 的 message 只有一句「Command failed + 命令行」。原来只记这一句，结果
// 2026-10-08 15:53 UTC 那次 claude 调用失败（在用户重新登录 17 分钟之后），事后完全查不出为什么。
// 子进程输出不一定是 UTF-8：cmd.exe 自己报的错（「不是内部或外部命令」「系统找不到指定的文件」）用系统代码页，
// 中文 Windows 是 GBK。一律按 UTF-8 解的话日志里只剩「退出码 1：���」—— 2026-10-09 codex 找不到时就是这样，
// 原因完全看不出来。**字节不是合法 UTF-8** 才改用 GBK 再解一次。
// 上一版看的是「解出来的字里有没有替换符 �」—— Codex 第十二轮复核：合法 UTF-8 里本来就可以有字面的 �
// （模型在 JSON 前面的废话里吐一个就够），于是整段被当 GBK 解坏、引证对不上、候选被误驳。现在严格校验字节。
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
function decodeOut(b) {
  if (typeof b === 'string') return b;
  if (!b || !b.length) return '';
  try { return strictUtf8.decode(b); } catch { /* 不是合法 UTF-8 */ }
  try { return new TextDecoder('gbk').decode(b); } catch { return b.toString('utf8'); }
}

// 第一行和最后一行都留：原因常常在第一行（cmd.exe 的「'codex.cmd' 不是内部或外部命令，也不是可运行的程序」后面还折了一行
// 「或批处理文件。」—— 只留最后一行就只剩这半句，Codex 第十三轮复核），而 codex 之类把最终原因写在最后一行。
function whyFailed(e) {
  const lines = String((e && e.stderr) || '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // 首行、末行各给 120 字：拼完再截的话，首行一长末行就整个没了（Codex 第十四轮复核）
  const said = lines.length > 1 ? `${lines[0].slice(0, 120)} … ${lines[lines.length - 1].slice(0, 120)}` : (lines[0] || '').slice(0, 200);
  // 没起来的（命令行太长、找不到程序）没有退出码，给错误码：PROMPT_TOO_LONG / ENAMETOOLONG 比「退出码 ?」有用
  const code = e && e.status == null && e.code ? String(e.code)
    : `退出码 ${e && e.status != null ? e.status : '?'}${e && e.signal ? `，信号 ${e.signal}` : ''}`;
  return `${code}：${said || String(e && e.message).split('\n')[0].slice(0, 200)}`;
}

// writer 锁：scribe 和 review 共用一把，同一时刻只有一个进程在改水位 / pending / log。
// 别人拿着就让路（不算失败）；锁机制本身不可用就**报错退出** —— 不能不加锁地跑。
async function takeWriterLock(ROOT, who) {
  const lk = await holdLock(ROOT, 'writer');
  if (lk.ok) return true;
  if (lk.busy) {
    process.stdout.write(`${who}: 另一个 scribe/review 正在跑，这次让路。\n`);
    return false;
  }
  throw new Error(`拿不到进程锁（${String((lk.error && (lk.error.code || lk.error.message)) || '?')}）`
    + '—— 宁可不跑，也不能不加锁地跑');
}

function filesOf(spec) {
  const out = [];
  for (const pat of spec.transcripts || []) {
    try { out.push(...fs.globSync(expandHome(pat))); } catch { /* 模式没匹配到就算了 */ }
  }
  return out;
}

// ---------------------------------------------------------------- 提取正文
// 只要正文和「动没动东西」这两样，其余（thinking、工具回显、注入的上下文块）全丢。
// thinking 尤其要丢：它是模型的内心戏，又长又不是结论。
//
// **逐行提取**：会话的每一行各自变成一个 unit —— { text: 这一行贡献的正文（可能为空）,
// wrote: 这一行动没动东西, user: 这一行是不是一轮用户提问的开头 }。
// 一个窗口、一段的正文都是各行 text 按顺序用换行拼起来，所以切段不会改变任何一行的内容（见 splitChunks）。

const textsIn = (content) => (Array.isArray(content)
  ? content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
  : (typeof content === 'string' ? content : ''));

// 会话记录里混着大量注入的上下文块（<system-reminder> / <recommended_plugins> …），
// 那不是人说的话，喂给小模型只会把判断带偏。
const injected = (t) => t.startsWith('<') || t.startsWith('﻿<');

const EMPTY = Object.freeze({ text: '', wrote: false, user: false });

function claudeUnit(line) {
  let d; try { d = JSON.parse(line); } catch { return EMPTY; }
  if (d.type === 'user') {
    const t = textsIn(d.message?.content).trim();
    return t && !injected(t) ? { text: `用户：${t}`, wrote: false, user: true } : EMPTY;
  }
  const c = d.type === 'assistant' ? d.message?.content : null;
  if (!Array.isArray(c)) return EMPTY;
  const parts = [];
  let wrote = false;
  for (const b of c) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && b.text) parts.push(`助手：${b.text}`);
    else if (b.type === 'tool_use') {
      if (WRITE_TOOLS.has(b.name)) wrote = true;
      parts.push(`〔工具 ${b.name}〕`);
    }
  }
  return { text: parts.join('\n'), wrote, user: false };
}

// codex 的同一条消息会记两次（response_item 和 item_completed，实测总是相邻两行），按 id 只认第一次。
// seen 由调用方带进来、**覆盖整个文件**：原来每次提取都新建一个，去重只在一次提取的范围内 ——
// 切段之后同一条消息的两条记录分到两段，两段各送一遍模型，最后同文不同 id 的两条都进了库
// （Codex 第九轮复核注入复现）。窗口边界恰好切在两条记录之间时也是同样的问题，只是更少见。
function codexUnit(line, seen) {
  let d; try { d = JSON.parse(line); } catch { return EMPTY; }
  const p = d.payload;
  if (!p || typeof p !== 'object') return EMPTY;
  const msg = (who, content, id) => {
    const s = textsIn(content).trim();
    if (!s || injected(s)) return EMPTY;
    if (id) {
      if (seen.has(id)) return EMPTY;
      seen.add(id);
    }
    return { text: `${who}：${s}`, wrote: false, user: who === '用户' };
  };
  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    return msg(p.role === 'user' ? '用户' : '助手', p.content, p.id);
  }
  if (p.type === 'agent_message') return msg('助手', p.content, p.id);
  if (p.type === 'custom_tool_call' || p.type === 'function_call') {
    return { text: `〔工具 ${p.name}〕`, wrote: WRITE_TOOLS.has(p.name), user: false };
  }
  if (p.type === 'item_completed') {
    const it = p.item || {};
    if (it.type === 'UserMessage') return msg('用户', it.content, it.id);
    if (it.type === 'AgentMessage') return msg('助手', it.content, it.id);
    if (it.type === 'FileChange' || it.type === 'CommandExecution') return { text: '', wrote: true, user: false };
  }
  return EMPTY;
}

// dsh 的会话记录和另外两家不是一个形状：
//   · 不是 JSONL，是**一个 JSON**（~/.dsh/storages/session_projcache/sessions/<id>.json），整份重写
//   · 里面没有完整对话，只有 turnOutline（每轮的 prompt/response，**都被截断**，末尾带 …）
//     加上 titleInput.first.text（完整的首条 prompt）和 todos（完整）
//   · session.v3.jsonl.zstd 那份**只有一行 session 头**，正文不在里面（实测 56 个全是）
//
// 所以这里把它转成**伪 JSONL**：**一个已结束的轮次一行，第 n 轮就在第 n-1 行**。水位按行数记，
// 所以行的位置必须只增不变 —— 这一点上一版没做到（Codex 第九轮复核）：那时是
// [首条, 各轮…, 待办, 动过东西] —— 末尾两个是**状态**不是对话，新的一轮插在它们**前面**，
// 于是 [首条, 第1轮, 动过] 扫完水位 3，多一轮之后变成 [首条, 第1轮, 第2轮, 动过]，slice(3) 只剩「动过」，
// 第 2 轮从来没送进模型、水位却越过了它。
// 现在：首条 prompt 并进第 1 轮（它就是第 1 轮的 prompt，只是没被截断）；「动过东西」是整个会话的属性，
// 写进每一行（只影响预筛，不影响正文）；待办不再提取 —— 它会被改写，没有稳定的位置，而它的内容
// 在各轮对话里本来就有。
// 实测 92 个会话：轮次编号全部从 1 连续、首条 prompt 全都在。编号不连续就**不读**（抛出 → 这一轮跳过并报出来），
// 不能拿位置去记一个不再按位置排的东西。
// **还没结束的那一轮不算**：它已经出现在 turnOutline 里、回答却是空的（实测 87e7ce79：第 3 轮 response 长度 0），
// 算进去的话水位越过它，回答写完之后再也读不到 —— 和 JSONL 的半截行是同一个缺陷。
function readDshUnits(file) {
  // 读不了、解析不了都**抛出**，不能返回空数组。原来返回 []，`--init` 外层的「读不了就退出」根本收不到异常，
  // 水位照样记成 0（Codex 第六轮复核发现）。正常扫描的外层对抛出的处理是「这一轮跳过这个文件」，安全。
  // dsh 的会话文件是整份重写的，正写到一半时解析不了也是常态 —— 同样跳过、下次再读。
  const rec = JSON.parse(fs.readFileSync(file, 'utf8')).record;
  if (!rec) throw new Error(`${file} 里没有 record`);
  // 防回流：scribe 自己调 dsh 时产生的会话落在沙盒 cwd 下，绝不能被自己扫到 ——
  // 那就是「记忆系统读自己的提问」。清理失败时这道过滤是兜底。
  const norm = (p) => String(p || '').replace(/[\\/]+/g, '/').toLowerCase();
  if (norm(rec.identity?.cwd) === norm(SANDBOX_CWD.dsh)) return [];
  const rows = rec.rows || {};
  const first = rows.titleInput?.val?.first?.text;
  const open = rows.turnBoundary?.val?.openTurnStartSeq;
  // 有没有动过东西：dsh 没有工具名可查，用「跑过工具的毫秒数」当代理指标。
  const acted = (rows.sessionStats?.val?.toolMs || 0) > 0;
  const units = [];
  for (const [i, t] of (rows.turnOutline?.val?.turns || []).entries()) {
    if (t.turn !== i + 1) {
      throw new Error(`轮次编号不连续（第 ${i + 1} 个是 ${t.turn}），按位置记的水位会错位`);
    }
    if (open != null && t.seq >= open) break;
    units.push(JSON.stringify({ k: 'turn', n: t.turn, prompt: i === 0 && first ? first : t.prompt, response: t.response, acted }));
  }
  return units;
}

function dshUnit(line) {
  let d; try { d = JSON.parse(line); } catch { return EMPTY; }
  if (d.k !== 'turn') return EMPTY;
  return { text: `用户：${d.prompt}\n助手：${d.response}`, wrote: !!d.acted, user: true };
}

// 窗口 [start, 末尾) 每一行的 unit。codex 先把 start 之前出现过的消息 id 过一遍，
// 这样「同一条消息只认整个文件里第一次出现」在窗口边界上也成立。
// 前面的行只为收集 id，先用子串筛掉不可能是消息的（消息记录的类型里都带 message / Message）。
function unitsOf(format, lines, start, end = lines.length) {
  if (format === 'codex') {
    const seen = new Set();
    for (let k = 0; k < start; k++) if (lines[k].includes('essage')) codexUnit(lines[k], seen);
    return lines.slice(start, end).map((l) => codexUnit(l, seen));
  }
  const one = format === 'dsh' ? dshUnit : claudeUnit;
  return lines.slice(start, end).map(one);
}

const FORMATS = new Set(['claude', 'codex', 'dsh']);
const joinText = (units) => units.map((u) => u.text).filter(Boolean).join('\n');

// 每种格式怎么把文件切成「行」。claude/codex 本来就是 JSONL，dsh 要先转。
// claude/codex 的会话是 JSONL，**只数完整的行**（见 lib/jsonl.mjs 的 completeLines）。
// 原来 split 之后连文件尾的半截行一起数进水位：auto 会被别的 agent 的 hook 触发，
// 那一刻 claude 可能正往会话里写最后一行 —— 半截行算进窗口、水位越过它，等它写完再也不会被读到，
// 最后那条消息就丢了。和 log 索引那边（Codex 第三轮复核复现）是同一个缺陷，当时只修了一边。
const READERS = {
  claude: (f) => completeLines(fs.readFileSync(f, 'utf8')),
  codex: (f) => completeLines(fs.readFileSync(f, 'utf8')),
  dsh: readDshUnits,
};

// ---------------------------------------------------------------- 叫模型
// Windows 上 .cmd 不能被 execFile 直接拉起（Node 修 CVE-2024-27980 之后是 EINVAL），
// 又不能开 shell:true —— 那样参数不转义。走 cmd.exe /c，两头都躲开。
// 「不落盘」开关的校验不在这里，在 assertNoPersist —— 见那里的注释。
// libuv（Windows）把 argv 拼成一条命令行的规则（src/win/process.c 的 quote_cmd_arg / make_program_args）：
// 空串 → ""；没有空格、制表符、双引号 → 原样；没有 " 也没有 \ → 两头加引号；否则两头加引号、每个 " 前加 \、
// 紧挨着 " 和参数结尾的那串 \ 翻倍。参数之间一个空格，末尾一个 NUL。
// 第十七轮按「每个参数都加引号、结尾的 \ 都翻倍」估，比实际多几个字：32699 字送得出去的提示被拦下了（第十八轮 C）。
function quotedLen(s) {
  if (!s) return 2;
  if (!/[ \t"]/.test(s)) return s.length;
  if (!/["\\]/.test(s)) return s.length + 2;
  let n = s.length + 2;
  let hit = true;                          // 从尾往前扫：结尾后面紧跟着闭引号
  for (let k = s.length - 1; k >= 0; k--) {
    if (s[k] === '"') { n += 1; hit = true; } else if (s[k] === '\\') { if (hit) n += 1; } else hit = false;
  }
  return n;
}
const cmdlineLen = (argv) => argv.reduce((n, s) => n + quotedLen(s), 0) + (argv.length - 1) + 1;

// 真正交给 execFileSync 的命令：替换占位符，.cmd/.bat 包一层 cmd.exe /c。
// cap = 这条命令行的上限：最终载体是 cmd.exe（.cmd 包装，或者配置里直接写 cmd.exe /c …）时 8191，否则 32767（都含 NUL）。
// 第十八轮 C：只看配置第一项是不是 .cmd，["cmd.exe","/c",x.cmd,"{prompt}"] 就按 32767 放过去了，cmd 当场报「命令行太长」。
function commandOf(spec, prompt) {
  // {prompt} 占位符：dsh 只能把任务当**位置参数**传（headless 没有 stdin 也没有任何开关）。
  // 走 execFileSync 的 argv 数组而不是 shell 字符串，所以换行、引号、& | > < 都原样送达 —— 实测过。
  // 替换用函数：字符串替换会把提示里的 $& $' 当成替换模式展开（第十七轮）。
  const argv = (spec.run || []).map((s) => s.replace('{model}', spec.model || '').replace('{prompt}', () => prompt));
  if (!argv.length) throw new Error('scribes.json 里这个 agent 没有配 run');
  let [file, ...args] = argv;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    args = ['/c', file, ...args];
    file = process.env.ComSpec || 'cmd.exe';
  }
  const viaCmd = /(^|[\\/])cmd(\.exe)?$/i.test(file);
  return { file, args, cap: viaCmd ? 8191 : 32767 };
}

// 一段会话窗口最多多「重」（splitChunks 用）：一般按字数，上限 MAX_WINDOW_CHARS。
// 提示经命令行传的（run 里有 {prompt}，即 dsh）还要放得进命令行：按转义后的**最坏**长度量（" 和 \ 各算 2），
// 预算 = 命令行上限 − 固定参数 − 提示模板（按最长的重问提示、反馈里全是引号算）。保守只会让段切短，不会丢内容。
const BAD_MAX = 1000;            // 重问时附上的「对不上的引文」最多这么多字（第十八轮 D：35000 字的错引文让重问提示超长）
function windowBudget(spec) {
  if (!spec || !(spec.run || []).some((s) => s.includes('{prompt}'))) return { max: MAX_WINDOW_CHARS, cost: (t) => t.length };
  const { file, args, cap } = commandOf(spec, RETRY_PROMPT('', '"'.repeat(BAD_MAX + 1)));
  const room = cap - cmdlineLen([file, ...args]) - 64;       // 64：余量
  return { max: Math.min(MAX_WINDOW_CHARS, room), cost: (t) => t.length + (t.match(/["\\]/g) || []).length };
}
// 取 text 的尾部，使 cost 不超过 max（cost 是逐字可加的）
function fitTail(text, max, cost) {
  let k = text.length; let used = 0;
  while (k > 0) { const c = cost(text[k - 1]); if (used + c > max) break; used += c; k -= 1; }
  return text.slice(k);
}

function runModel(spec, prompt, agent) {
  const fault = process.env.AGENTMEM_FAULT || '';
  // 验收用的故障注入：运行时才报的「命令行太长」，以及「提示里带某个记号时送不出去」
  if (fault === 'model-enametoolong') throw Object.assign(new Error('注入的 ENAMETOOLONG'), { code: 'ENAMETOOLONG' });
  if (fault.startsWith('prompt-too-long:') && prompt.includes(fault.slice('prompt-too-long:'.length))) {
    throw Object.assign(new Error('注入的提示超长'), { code: 'PROMPT_TOO_LONG' });
  }
  const { file, args, cap } = commandOf(spec, prompt);
  // 超了命令行上限是**这一条提示**的问题，不是模型挂了 —— 不启动进程，给个明确的 code，
  // 调用方据此只处理这一条（第十七轮复核：一条超长提示把好好的审核者熔断了）。
  const len = cmdlineLen([file, ...args]);
  if (len > cap) throw Object.assign(new Error(`命令行 ${len} 字，超过 ${cap} 字上限`), { code: 'PROMPT_TOO_LONG' });
  const sandbox = SANDBOX_CWD[agent];
  let before = null;
  if (sandbox) { fs.mkdirSync(sandbox, { recursive: true }); before = snapshotDsh(); }
  try {
    return decodeOut(execFileSync(file, args, {
      input: prompt,
      cwd: sandbox || undefined,
      // dsh 没有「不许用工具」的开关，只有权限预设：强制只读（默认 workspace-write）。见 assertIsolated。
      env: spec.format === 'dsh' ? { ...process.env, DSH_PERMISSION_MODE: 'read-only' } : process.env,
      timeout: MODEL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch (e) {
    if (e) { e.stdout = decodeOut(e.stdout); e.stderr = decodeOut(e.stderr); }
    throw e;
  } finally {
    // 放 finally：模型失败时它照样已经建了会话，不清就会堆。
    if (sandbox) cleanupDsh(before, sandbox);
  }
}

// 小模型不一定只吐 JSON —— 实测 deepseek-flash 会先吐一整段推理。
// 扫出所有配平的 {...}，从最后一个开始试，第一个解析成功的就是答案。
function parseLooseJson(s) {
  const found = [];
  let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth += 1; }
    else if (c === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) { found.push(s.slice(start, i + 1)); start = -1; }
      if (depth < 0) depth = 0;
    }
  }
  for (let i = found.length - 1; i >= 0; i--) {
    try { return JSON.parse(found[i]); } catch { /* 试上一个 */ }
  }
  return null;
}

const SCRIBE_PROMPT = (window) => `你是记忆记录员。判断下面这段 agent 会话里有没有「值得长期记住、以后还会再遇到」的事实。

只有这些算值得：踩了坑并查明原因 · 做了有取舍的决定 · 找到可复用的解法 · 达成里程碑。
这些不算：改个数值 / 重命名 / 例行提交 / 只是读了代码 / 任务本身的流水账。

只输出 JSON，不要代码块围栏，不要任何解释：
{"worth":true/false,"type":"pitfall|decision|solution|progress","title":"一句话，二十字以内","text":"两三句：现象、原因、具体判据或修法","quotes":["原话一","原话二"]}
worth=false 时 title/text 留空字符串、quotes 留空数组。
text 里必须有具体的东西（命令、路径、标识符、数字），只有感想的不要写。

**只记一件事。** 一条记忆对应一个教训，别把一次会话里的几件事揉进同一条。

**按这个顺序做，不要颠倒：**
1. 先在下面片段里挑出 1 到 3 段**逐字复制**的原话（每段 20 到 200 字）当 quotes；
2. 然后**只看着这几段**写 title 和 text。

写正文时，你从上文读到但**没被你选进 quotes** 的事实，一个都不许用 —— 哪怕你确信它是真的。
写完自检一遍：正文里每个文件名、每个数字、每个专有名词，能在 quotes 里找到吗？找不到就把那部分删掉。

quotes 不要改写、不要把相隔两处拼成一段、不要自己造句。一段之内要跳过内容就写 …。
**这些会被程序逐字核对，对不上整条作废；审核员也只看得到 quotes，正文超出的部分会被判夸大。**

【会话片段】
${window}`;

// 审核者拿到的是「记忆 + 已被脚本核实过的原文引证」，不是整个会话窗口。
//
// 为什么不给整个窗口：实测给过。16000 字的源里证据散落在四处，
// gpt-5.6-luna@low 判成「源片段未提及」—— 而那些词在源里出现了 13 / 5 / 2 / 2 次。
// 大海捞针式的忠实性核对，便宜模型做不了，结果是**系统性误驳**。
// 「引证是否真实存在」已经由脚本逐字核对（零信任），模型只需判短上下文里的可复用性。
const RETRY_PROMPT = (window, bad) => `你刚才给的引证在原文里逐字对不上，整条因此作废了。

对不上的是这段：
${bad.length > BAD_MAX ? `${bad.slice(0, BAD_MAX)}…（后面略）` : bad}

重来一次。quotes 里的每一段都必须像**用鼠标框选复制**那样逐字照搬，
一个字都不能改、不能顺手把错别字改对、不能把相隔两处拼成一段。段内要跳过内容就写 …。

${SCRIBE_PROMPT(window)}`;

// 候选里 quotes 是哪一种：source-span-v3 = 程序按位置从原文摘出、带上下文的原文（见 excerptOf）。
// 没有这个标记的（旧版候选、手工恢复的、别处来的）一律当「候选自己给的引文」—— 只认明确的版本号，
// 不靠「有没有 modelQuotes」猜（Codex 第十四轮复核：[]、true 这类值也会被当成新格式）。
// **摘段逻辑每修一次就升一次版本**：v2 的摘段会把 1000 截成 10、漏掉闭引号前的上一句（第十六轮复核：
// 存量的 v2 候选照样被当成可信原文）。旧版本的候选审核前能重新摘就重新摘（见 reextract），摘不了就当未核对。
// v4（第十八轮）：第十七轮改了句界和 … 标记却没升版本，已经落盘的 v3 候选（C:/foo!目录! 这种截坏的值、不标 …）
// 直接被当成新格式担保了。v4 起候选还带 windowSha（整段窗口正文的哈希），重新摘段时靠它核对内容。
const QUOTE_FORMAT = 'source-span-v4';
const verifiedQuotes = (cand) => cand.quoteFormat === QUOTE_FORMAT && Array.isArray(cand.quotes);
const windowSha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// 审核提示**整段**按引文格式分支。上一版开头无条件写「原文摘段可以当作事实」，下面旧版候选那一段又写
// 「不能当事实」—— 同一个提示里既担保又否认（Codex 第十四轮复核）。
const REVIEW_PROMPT = (cand) => {
  const ok = verifiedQuotes(cand);
  return `你是记忆审核员。下面有一条**别人写的**候选记忆，${ok
    ? '和程序从原始会话里**按位置原样摘出来的**原文（带前后文；两头的 … 表示原文还在继续）。\n'
      + '摘段里的字逐字出自原文，可以当作事实；但它**只是原文的一部分**，更远处可能还有限定条件。候选正文是别人的转述，**不一定忠实**。'
    : '和它自己给的引文。\n这是旧版候选：引文**没有**按原文回填，可能被改写过，**不能当事实**，只能当线索；正文的具体值核对不了时从严。'}

驳回它，如果：**核心主张**在${ok ? '原文摘段' : '引文'}里找不到依据 · 只是流水账没有可复用内容 ·
没有具体判据（说了「要小心」却没说怎么判断）· 把一次性的项目细节写成了普适规则 ·
**正文里的具体值和${ok ? '原文摘段' : '引文'}对不上**（数值、名字、路径、命令、引号里的内容 —— 哪怕只差一个空格或一个引号）·
**正文的结论和原文相反或有条件没说**（原文说「不能」「仅用于」「除非」，正文却说成无条件的「要」「可以」）。

判「找不到依据」只针对**主张本身**：措辞不同、概括、换个说法都不算问题，
只有当正文断言了一件原文里完全没提的事，或者把原文里的具体值、条件写错了，才算。

只输出 JSON，不要代码块围栏，不要任何解释：
{"accept":true/false,"reason":"一句话说明"}

【待审记忆】
标题：${cand.title}
正文：${cand.text}

${ok ? '【原文摘段】' : '【候选给的引文】'}
${(cand.quotes || []).map((q, i) => `${i + 1}. ${q}`).join('\n') || '（无）'}${cand.similar ? `

【库里已有的一条很像的记忆】（相似度 ${cand.similar.score}）
标题：${cand.similar.title}
正文：${cand.similar.text}

和它讲的是**同一件事**（同一个对象、同一个结论，只是换了说法）→ 驳回，理由写「已记过」。
只是主题相近，但对象 / 数值 / 版本 / 结论不同（例如端口 3001 和 3002、A 服务器和 B 服务器）→ 不算重复，照常判。` : ''}`;
};

// ---------------------------------------------------------------- ①层脚本闸
// 这些检查零成本、零信任，放在模型前后各一道。CLAUDE.md：「能变成脚本的检查就别交给模型」。
const hasSpecifics = (t) => /[/\\.]|[A-Za-z_][A-Za-z0-9_]{2,}|\d/.test(t || '');

// 「引证是否真的出自原文」是个**字符串比对**，不是判断题 —— 所以归脚本，零信任。
// 把它交给模型是上一版的错：便宜模型在一万多字里找证据会漏，于是系统性误驳。
//
// 引证要做两件事：① 证明它出自原文；② 让审核者看到**原文本来的样子**。几轮复核一路收紧到现在：
//   · 交给审核者、写进候选的是**按位置从原文摘出来的原文**，不是模型写的引文（第十三轮：模型把 "a b" 抄成 "ab"，
//     宽松比对照样通过，审核者看到的是改过的值）；
//   · **每一个**省略号片段都要按顺序找到，至少一个 ≥ 6 字当锚（第十三轮：不足 6 字的片段被忽略，「…9999」可以编）；
//   · 片段**先逐字找，找不到才宽松找**（忽略空白和引号样式 —— 模型常把换行、缩进、「」和 "" 换掉，硬卡会系统性误杀）。
//     第十四轮：原文先有 VALUE="a b"、后有 VALUE="ab"，引文 VALUE="ab" 被宽松地定位到前面那个；
//   · 片段的头尾**不许切在一个数字中间**（第十四轮：原文 timeout=1000，引文 timeout=1，摘段也只到 1）。只管数字：
//     截断数字直接变成另一个值；英文标识符、路径被截断时，摘段带着所在句子，审核者看得到完整的词 ——
//     对英文也一刀切的话，模型从一个词中间开始抄的正常引文会被误杀（验收 29t 的桩就是这样被误伤的）；
//   · 摘段**带上下文**：相距不远的片段连同中间省略的原文一起给（第十四轮：原文「必须为3001，绝对不能设为9999」，
//     引文「必须为…9999」，原来的摘段和一段真说「必须为9999」的原文一字不差）；两头各扩到**所在句子再多一句**
//     （第十五轮：上一句写着「以下配置禁止使用」，只扩到本句就看不到）；
//   · 扩展停在半个词 / 数字上时**把它补完**，两头没到句子边界就标 `…`（第十五轮：引文本身完整，往外扩 80 字正好停在
//     1000 中间，摘段只剩 10 —— 扩展自己又把值截断了；长路径、长标识符同理）；
//   · 有上限：每段引文最多 6 个片段、每段摘段最多 2000 字（第十五轮：三段引文能展开成 5.8 万字，dsh 走命令行参数直接
//     ENAMETOOLONG）。
// **上限**：摘段只是原文的一部分，限定条件写在两句以外（或者远处另一段）时审核者看不到 —— 任何有限长度的摘段都兜不住，
// 记在 README。审核提示里也如实说「摘段只是一部分」。
const SKIP_CH = /[\s　「」『』"'“”‘’]/;
const QUOTE_CH = /[「」『』"'“”‘’]/;
const DIGIT = /[0-9]/;
// 数字、标识符、路径、URL 里的字符：扩展到上限时停在它们中间，要补完
const TOKEN_CH = /[A-Za-z0-9_.\-\/\\:!?=&%#@~+]/;
const NEAR_GAP = 400;        // 片段之间不超过这么多字，就把中间省略的原文一并给出
const CONTEXT_MAX = 200;     // 往两头扩（所在句子 + 再多一句），每头最多这么多字
const TOKEN_MAX = 80;        // 补完半个词 / 数字最多再走这么多字
const MAX_PARTS = 6;         // 一段引证最多几个省略号片段
const EXCERPT_MAX = 2000;    // 一段摘段最多这么多字
const norm = (s) => [...String(s || '')].filter((ch) => !SKIP_CH.test(ch)).join('');
// 原文去掉空白和引号之后的字符串，以及每个字符在原文里的位置（同一个窗口要核好几段，算一次）
let hayCache = { src: null, hay: '', pos: [] };
function hayOf(window) {
  if (hayCache.src !== window) {
    let hay = ''; const pos = [];
    for (let k = 0; k < window.length; k++) if (!SKIP_CH.test(window[k])) { hay += window[k]; pos.push(k); }
    hayCache = { src: window, hay, pos };
  }
  return hayCache;
}
// pos 里第一个 ≥ at 的下标（宽松查找从原文位置 at 往后找时用）
function hayIndexFrom(pos, at) {
  let lo = 0; let hi = pos.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pos[mid] < at) lo = mid + 1; else hi = mid; }
  return lo;
}
// 这一处是不是切在一个数字中间（k 左右两个字符都是数字）
const cutsNumber = (window, k) => k > 0 && k < window.length && DIGIT.test(window[k - 1]) && DIGIT.test(window[k]);

// 一个片段在原文 at 之后**所有**可能的位置：逐字命中在前、宽松命中在后；切在数字中间的不算
// （第十五轮：原文先有 timeout=1000、后有 timeout=1，引文 timeout=1 命中前面那个就直接判失败）。
function* hitsOf(raw, window, at) {
  for (let from = at; ;) {
    const i = window.indexOf(raw, from);
    if (i < 0) break;
    if (!cutsNumber(window, i) && !cutsNumber(window, i + raw.length)) yield [i, i + raw.length];
    from = i + 1;
  }
  const p = norm(raw);
  const { hay, pos } = hayOf(window);
  for (let from = hayIndexFrom(pos, at); ;) {
    const i = hay.indexOf(p, from);
    if (i < 0) return;
    const a = pos[i]; const b = pos[i + p.length - 1] + 1;
    if (!cutsNumber(window, a) && !cutsNumber(window, b)) yield [a, b];
    from = i + 1;
  }
}

// 一段引证在原文里的位置：找到了返回各片段的 [起, 止)，找不到返回 null。
// 片段之间**会回溯**：前一个片段换个位置，后面的才拼得上时也要找到（第十六轮：前面有一串合法的宽松命中，
// 后面先撞上一个逐字命中、接不上结尾，原来就整条判失败）。最多试 MAX_TRIES 个位置，防止病态输入拖死。
const MAX_TRIES = 500;
function spansOf(quote, window) {
  const raws = String(quote || '').split(/…+|\.{3,}/).map((x) => x.trim()).filter((x) => norm(x));
  if (!raws.length || raws.length > MAX_PARTS || !raws.some((x) => norm(x).length >= 6)) return null;
  let tries = MAX_TRIES;
  const walk = (k, at) => {
    if (k === raws.length) return [];
    for (const [a0, b0] of hitsOf(raws[k], window, at)) {
      if (--tries < 0) return null;
      let a = a0; let b = b0;
      // 紧挨着的引号一起算进来（VALUE="a b" 而不是 VALUE="a b）
      while (a > 0 && QUOTE_CH.test(window[a - 1])) a -= 1;
      while (b < window.length && QUOTE_CH.test(window[b])) b += 1;
      const rest = walk(k + 1, b);
      if (rest) return [[a, b], ...rest];
      if (tries < 0) return null;
    }
    return null;
  };
  return walk(0, 0);
}

// ---- 句子边界
// **只认中文全角句末（。！？）和换行**。英文 . ! ? 一律不算 —— 它们会出现在路径、URL、版本号、引号里的值中间，
// 一当成句末，摘段就停在字面值中间：
//   第十六轮 C:/foo!bar!secret 停在 C:/foo!bar!；改成「! 后面跟词字符才不算」之后，
//   第十七轮 C:/foo!目录!私密（! 后面是中文）、"foo!　bar!　secret"（! 后面是全角空格）照样被截 —— 白名单永远补不完。
// 不认英文句末的代价只是多带点上下文（到 200 字上限照样标 …），不会把一个值切坏。
// 中文句末也可能出现在值里（"甲！乙！丙"），所以停在边界上同样标 …（见 widen 的返回值）：猜错边界时值也许不全，但不会装作是全的。
// 一串「句末符号 + 闭引号 / 闭括号 + 空白」算**一个**边界 —— 第十六轮：「“以下配置禁止使用。”\n配置参数…」，
// 闭引号把它拆成两个边界，往前多带一句的那一步刚跨过换行就停了，上一句一个字都没带上。
const RUN_CH = /[。！？!?\s”’」』）)\]】》"']/;
const isSentEnd = (window, k) => /[。！？\n]/.test(window[k]);
// 以 k 为界、往 dir（-1 往前 / +1 往后）方向的一串边界字符：返回 [这串的另一头, 这串里有没有句末]。最多看 CONTEXT_MAX 个字。
function runAt(window, k, dir) {
  let r = k; let hasEnd = false;
  for (let n = 0; n < CONTEXT_MAX; n++) {
    const i = dir < 0 ? r - 1 : r;
    if (i < 0 || i >= window.length || !RUN_CH.test(window[i])) break;
    if (isSentEnd(window, i)) hasEnd = true;
    r += dir;
  }
  return [r, hasEnd];
}

// 从 [a, b) 往两头扩：所在句子 + 再多一句，每头最多 ctx 字；停在半个词 / 数字上就补完。
// 返回 [起, 止, 左边还有, 右边还有]（没到文本两端，显示时标 …）。
function widen(window, a, b, ctx) {
  let s = a; let e = b; let cutL = false; let cutR = false;
  for (let crossed = 0; ;) {
    if (s <= 0) break;
    if (a - s >= ctx) { cutL = true; break; }
    if (RUN_CH.test(window[s - 1])) {
      const [r, hasEnd] = runAt(window, s, -1);
      if (hasEnd && crossed++ === 1) break;          // 第二个边界：停在它后面
      s = r;                                          // 跨过这一串（是边界就进到上一句，不是就只是空白 / 引号）
    } else s -= 1;
  }
  for (let crossed = 0; ;) {
    if (e >= window.length) break;
    if (e - b >= ctx) { cutR = true; break; }
    if (RUN_CH.test(window[e])) {
      const [r, hasEnd] = runAt(window, e, +1);
      e = r;                                          // 连句末符号、闭引号一起带上
      if (hasEnd && ++crossed > 1) break;
    } else e += 1;
  }
  // 扩展停在半个词 / 数字 / 路径上：补完（第十五轮：停在 1000 中间只剩 10）
  if (cutL) for (let k = 0; k < TOKEN_MAX && s > 0 && TOKEN_CH.test(window[s - 1]) && TOKEN_CH.test(window[s]); k++) s -= 1;
  if (cutR) for (let k = 0; k < TOKEN_MAX && e < window.length && TOKEN_CH.test(window[e - 1]) && TOKEN_CH.test(window[e]); k++) e += 1;
  // 没到文本两端就标 …，**停在句子边界上也标**：「边界」是按字符猜的，猜错时（值里本身带 ！ 。）
  // 不标的话审核者看到的是一个被截短、却像是完整的值（第十七轮复核：C:/foo!目录!私密 摘成 C:/foo!目录!，没有 …）。
  return [s, e, s > 0, e < window.length];
}

// 交给审核者的原文：相距不超过 NEAR_GAP 的片段合成一段（中间省略的原文一并给出），两头扩上下文；
// 扩完之后**重叠的再合并**（第十六轮：两段扩完重叠，显示成「中间隔了 -159 字」、原文重复）；
// 隔得远的分开给，注明中间隔了多少字。没到句子边界的一头标 …（原文还在继续）。
// 超过 EXCERPT_MAX 时先把上下文收窄（200 → 60 → 0）再看，锚点本身永远保留 ——
// 第十六轮：一串几千个换行把摘段撑过 2000 字，最后一刀把锚点整个裁掉了。
function excerptOf(spans, window) {
  const groups = [];
  for (const [a, b] of spans) {
    const g = groups[groups.length - 1];
    if (g && a - g[1] <= NEAR_GAP) g[1] = b; else groups.push([a, b]);
  }
  const render = (ctx) => {
    const parts = [];
    for (const [a, b] of groups) {
      const w = widen(window, a, b, ctx);
      const last = parts[parts.length - 1];
      if (last && w[0] <= last[1]) { last[1] = Math.max(last[1], w[1]); last[3] = w[3]; } else parts.push(w);
    }
    return parts.map(([s, e, cl, cr], i) => (i ? `（……中间隔了 ${s - parts[i - 1][1]} 字……）\n` : '')
      + (cl ? '…' : '') + window.slice(s, e).trim() + (cr ? '…' : '')).join('\n');
  };
  for (const ctx of [CONTEXT_MAX, 60, 0]) {
    const out = render(ctx);
    if (out.length <= EXCERPT_MAX) return out;
  }
  const out = render(0);   // 光锚点就超了（引证本身太长）：只能截，并注明
  return `${out.slice(0, EXCERPT_MAX)}…（摘段过长，后面截掉了 ${out.length - EXCERPT_MAX} 字）`;
}

// 找到了返回带上下文的原文摘段，找不到返回 null。
function locateQuote(quote, window) {
  const spans = spansOf(quote, window);
  return spans ? excerptOf(spans, window) : null;
}

// 每一段都要核实。一段引证撑不起一条多点记忆 —— 实测审核者会一致地判「正文超出引证」，
// 于是通过率是 0/4。所以证据是一组，不是一段；这里逐段核，有一段假整条作废。
// 全都找到了返回原文摘段的数组，否则 null。
function locateQuotes(quotes, window) {
  if (!Array.isArray(quotes) || !quotes.length || quotes.length > 3) return null;
  const spans = quotes.map((q) => locateQuote(q, window));
  return spans.every((s) => s !== null) ? spans : null;
}

// 审核前把**旧版本**的候选重新摘一遍：会话原文还在、窗口坐标可信，就用模型当初写的引文按现在的规则重新定位、
// 重新摘段（升成当前版本）；摘不了就原样返回，审核提示里会标成「不能当事实」。
// claude / codex 的会话只追加不改，窗口里的行不会变；dsh 只有新切法（layout 2）的窗口坐标对得上现在的行。
// **还要核对内容**（第十七、十八轮复核：会话文件被同路径重写、或者前面删了几行，同一个 [起, 止) 就指向了另一段话，
// 实测原处「禁止用于生产」、新处「允许用于生产」照样升级、被担保成原文）：
//   · 有 windowSha（v4 起）：重新拼出的整段窗口哈希必须一致；
//   · 没有的（v2 / v3）：只存了窗口最后 3000 字（excerpt），重新拼出的窗口末尾必须和它**整段相等**
//     （只比 endsWith 的话，两个字的 excerpt 也能过）。窗口比 3000 字长时前部核对不了，
//     所以重新摘出的每一段都必须落在这 3000 字里，否则不升级。
// 只用于给审核者看，不改 pending 里的文件。sources 是这一轮读过的会话（同一个会话的候选常常好几条），最多留 4 个。
const SOURCE_CACHE_MAX = 4;
const EXCERPT_KEEP = 3000;       // 候选里 excerpt 存窗口最后这么多字
// 摘段拆回原文片段：去掉「中间隔了」分隔、两头的 …、末尾的截断说明
const excerptParts = (q) => q.replace(/…（摘段过长，后面截掉了 \d+ 字）$/, '')
  .split(/\n?（……中间隔了 -?\d+ 字……）\n/)
  .map((x) => x.replace(/^…/, '').replace(/…$/, '').trim())
  .filter(Boolean);
function reextract(cand, scribes, sources) {
  if (verifiedQuotes(cand)) return cand;
  const spec = Object.hasOwn(scribes, cand.agent) ? scribes[cand.agent] : null;
  const mq = Array.isArray(cand.modelQuotes) ? cand.modelQuotes : (Array.isArray(cand.quotes) ? cand.quotes : null);
  const w = cand.window;
  const sha = typeof cand.windowSha === 'string' && cand.windowSha ? cand.windowSha : null;
  if (!spec || !FORMATS.has(spec.format) || !mq || !mq.length || typeof cand.sourceFile !== 'string'
    || (!sha && (typeof cand.excerpt !== 'string' || !cand.excerpt))
    || !Array.isArray(w) || !Number.isInteger(w[0]) || !Number.isInteger(w[1]) || w[0] < 0 || w[0] >= w[1]) return cand;
  if (spec.format === 'dsh' && cand.layout !== 2) return cand;
  try {
    if (!sources.has(cand.sourceFile)) {
      if (sources.size >= SOURCE_CACHE_MAX) sources.delete(sources.keys().next().value);   // 最早读的那个先扔
      sources.set(cand.sourceFile, (READERS[spec.format] || READERS.claude)(cand.sourceFile));
    }
    const lines = sources.get(cand.sourceFile);
    if (lines.length < w[1]) return cand;
    let text = joinText(unitsOf(spec.format, lines, w[0], w[1]));
    const { max, cost } = windowBudget(spec);
    if (cost(text) > max) text = fitTail(text, max, cost);                     // 和当时送模型的一样（见 splitChunks）
    if (sha ? windowSha(text) !== sha : text.slice(-EXCERPT_KEEP) !== cand.excerpt) return cand;   // 内容对不上
    const located = locateQuotes(mq, text);
    if (!located) return cand;
    if (!sha && text.length > EXCERPT_KEEP) {
      const tail = text.slice(-EXCERPT_KEEP);
      if (!located.every((q) => excerptParts(q).every((x) => tail.includes(x)))) return cand;   // 有一段落在核对不了的前部
    }
    return { ...cand, quotes: located, modelQuotes: mq, quoteFormat: QUOTE_FORMAT };
  } catch { return cand; }
}

// 模型可能吐 quotes 数组，也可能退回单个 quote 字符串。两种都收。
const asQuotes = (got) => {
  if (Array.isArray(got.quotes)) return got.quotes.map((q) => String(q || '').trim()).filter(Boolean);
  if (typeof got.quote === 'string' && got.quote.trim()) return [got.quote.trim()];
  return [];
};

// 去重**只看已进库的**（log 的索引），不看 pending 里还没审的候选。
// 上一版两处都看，Codex 第十轮复核推翻：没审过的候选不能拿来压别人 —— 旧窗口产了一条引证很弱的候选，
// 新窗口给出同一件事的强引证，被判「已记过」、水位越过；之后弱的那条被驳回，强的那条再也没有机会（注入复现：最终 log 0、pending 0）。
// 代价：同一件事在审核前可能有两条候选、都通过就进库两条 —— 重复比丢失好。
// （「分段后同一条消息产两条」那个真正的来源已经在提取层按 id 去掉了，见 codexUnit。）
//
// 而且分两档（Codex 第十一轮复核）：
//   · **逐字相同**（标题和正文归一化后都一样）→ 已记过，不发布 —— 没有任何信息会丢；
//   · 相似度 ≥ 0.96 → **不再直接丢掉**：照常发布，把库里最像的那条一起交给审核者判「是不是同一件事」（见 REVIEW_PROMPT）。
// 原来 ≥ 0.96 就直接越过：e5 对中文整体偏高，两条不同事实（服务器 A/端口 3001 与 B/3002）实测 0.988，
// 「同一件事换说法」才 0.9702 —— 两个分布重叠，没有一条线分得开。被误判的候选不发布、水位越过，就永久丢了。
// 交给审核者至少是一个看过两条原文的判断，判错了驳回也留档在 rejected/，捞得回来。
// 返回 { exact, similar }：similar = 库里最像的那条（≥ 0.96 才给）{ id, title, text, score }。
const same = (a, b) => String(a || '').replace(/\r\n/g, '\n').trim() === String(b || '').replace(/\r\n/g, '\n').trim();
async function nearestMemory(ctx, title, body) {
  const db = ctx.openIndex();
  try {
    // 必须先补索引：vec 表是 recall 惰性填的，而 scribe 很可能在任何 recall 之前就跑了。
    // 不同步的话 vec 是空的，去重闸会静默全放行 —— 又一个「失败是绿色的」。
    await ctx.syncIndex(db);
    const rows = db.prepare('SELECT v.id AS id, v.v AS v, m.title AS title, m.text AS text FROM vec v JOIN mem m ON m.id = v.id').all();
    if (!rows.length) return { exact: false, similar: null };
    const [qv] = await ctx.embedMany([`${title}\n${body}`], 'passage: ');
    let best = null;
    for (const r of rows) {
      // 逐字相同就是逐字相同：只去掉首尾空白、统一换行。上一版用了引证核对的那个 norm（删掉**所有**空白和引号），
      // Codex 第十二轮复核：`VALUE="a b"` 和 `VALUE="ab"` 被判成相同、当「已记过」丢了 —— 又是一次永久误杀。
      if (same(r.title, title) && same(r.text, body)) return { exact: true, similar: null };
      const score = ctx.cosine(qv, ctx.blobToVec(r.v));
      if (!best || score > best.score) best = { id: r.id, title: r.title, text: r.text, score };
    }
    // 带进候选的库里那条截个长：它要进 pending 留档、还要发给审核模型，不该无上限（Codex 第十二轮复核）
    return {
      exact: false,
      similar: best.score >= DUP_THRESHOLD ? {
        id: best.id, title: String(best.title).slice(0, 200), text: String(best.text).slice(0, 1500),
        score: Math.round(best.score * 1000) / 1000,
      } : null,
    };
  } finally { db.close(); }
}

// ---------------------------------------------------------------- scribe
export async function cmdScribe(ctx, args) {
  const { ROOT } = ctx;
  const scribes = loadScribes(ROOT);
  const only = typeof args.agent === 'string' ? args.agent : null;

  // --probe：只跑提取器，不叫模型。用来验证「解析器认不认识磁盘上真实的会话记录」——
  // 假数据可能和解析器一起错，这条就是为了不让那种错溜过去。
  if (args.probe) {
    for (const [agent, spec] of Object.entries(scribes)) {
      if (!FORMATS.has(spec.format)) continue;
      let chars = 0; let n = 0;
      for (const f of filesOf(spec).slice(-3)) {
        try {
          const lines = (READERS[spec.format] || READERS.claude)(f);
          chars += joinText(unitsOf(spec.format, lines, Math.max(0, lines.length - 400))).length;
          n += 1;
        } catch { /* 读不了就跳过 */ }
      }
      process.stdout.write(`${agent}  ${chars} 字  （取最近 ${n} 个会话文件的尾部）\n`);
    }
    return;
  }

  // 下面要写水位、写候选：先拿 writer 锁（和 review 共用一把，见 cmdReview）。
  // **水位必须在拿到锁之后才读**，否则读到的是别人改之前的旧值。
  if (!(await takeWriterLock(ROOT, 'scribe'))) return;
  const mark = loadMark(ROOT);
  // 上次发布到一半被杀留下的 .tmp，见下面「发布候选是三步」。
  // 必须在 dsh 水位换算之前：旧版留下的 .tmp 记的是旧切法下的窗口，得拿旧水位比。
  reconcileStaged(ROOT, mark, new Set(Object.values(scribes).flatMap(filesOf)), scribes);

  // --init：把水位直接设到各文件当前末尾。
  // 不这么做的话首次运行会回溯全部历史 —— 光我自己那个会话就 1 万行，
  // 那是几百次模型调用。历史记忆已经迁过来了，不需要再扫一遍。
  if (args.init) {
    let n = 0;
    for (const [agent, spec] of Object.entries(scribes)) {
      // --init 认 --agent：**新加一个 agent 时只初始化它**，不能顺手把别家的水位
      // 一起推到末尾 —— 那会把它们攒着还没处理的内容静默抹掉。
      // （2026-09-23 踩到：codex 摘掉两天后加回来，650 个 rollout 全不在水位表里，
      //   最大的单个 75MB；而 auto.mjs 那道联锁只查「水位文件在不在」，文件在，挡不住。）
      if (only && agent !== only) continue;
      for (const f of filesOf(spec)) {
        // 读不了就退出、一个水位都不写。原来记成 0，等于下次把这个会话从头重扫一遍、
        // 已经发布过的候选再产一遍（Codex 第五轮复核注入复现：水位 2→0→2，同一段进库两条）。
        try {
          readFault('init-read');
          mark[f] = (READERS[spec.format] || READERS.claude)(f).length;
        } catch (e) {
          throw new Error(`--init 读不了 ${f}（${e.code || e.message}）—— 没有写任何水位，修好再重跑`);
        }
        if (spec.format === 'dsh') (mark[LAYOUT] ||= {})[f] = 2;
        if (mark[CONT]) delete mark[CONT][f];
        n += 1;
      }
    }
    saveMark(ROOT, mark);
    process.stdout.write(`水位已对齐到当前末尾：${n} 个会话文件${only ? `（只 ${only}）` : ''}，历史不回溯。\n`);
    return;
  }

  // dsh 旧水位换算：换算完立刻落盘，之后才可能暂存新的 .tmp —— 见 migrateDshMarks。
  // 放在 --init 之后、只在真正扫描时做：放在前面的话，`--init --agent claude` 读失败退出时，
  // 别家的 dsh 水位已经换算落盘了，「没有写任何水位」那句话就是假的（Codex 第十一轮复核注入复现）。
  migrateDshMarks(ROOT, mark, scribes);

  assertNoPersist(scribes);   // 真正要叫模型了，先验配置
  const pendDir = path.join(ROOT, 'pending');
  fs.mkdirSync(pendDir, { recursive: true });
  let made = 0; let skipped = 0; let called = 0; let fails = 0; let capped = 0; let stuckFiles = 0;

  // 第二道冷启动联锁：某个 agent 的文件**绝大多数都没水位** = 它是刚加进来的，
  // 直接扫会把它的全部历史会话重跑一遍。
  //
  // auto.mjs 里那道联锁只查「scribemark.json 存不存在」，对这种情况**完全无效**——
  // 文件在，只是新 agent 一条记录都没有。2026-09-23 codex 加回来时就是这样：
  // 650 个 rollout 全不在表里，最大的单个 75MB。
  const UNMARKED_LIMIT = 20;
  for (const [agent, spec] of Object.entries(scribes)) {
    if (only && agent !== only) continue;
    const all = filesOf(spec);
    const unmarked = all.filter((f) => mark[f] === undefined).length;
    if (all.length >= UNMARKED_LIMIT && unmarked > all.length * 0.8) {
      process.stderr.write(`scribe: [${agent}] ${all.length} 个会话文件里 ${unmarked} 个没有水位，`
        + `看起来是刚加进来的。先跑 \`memo scribe --init --agent ${agent}\` 再扫，`
        + `否则会把它全部历史会话重跑一遍。本轮跳过 ${agent}。\n`);
      continue;
    }
    if (!FORMATS.has(spec.format)) { process.stderr.write(`scribe: ${agent} 的 format=${spec.format} 不认识，跳过\n`); continue; }
    const budget = windowBudget(spec);
    if (budget.max < 2000) {
      // 固定参数和提示模板就把命令行占满了：段只能切成几个字，等于不让模型看。配置问题，说出来、这一家不跑。
      process.stderr.write(`scribe: ${agent} 的提示经命令行传，固定部分太长，留给会话的只有 ${budget.max} 字，本轮跳过 ${agent}\n`);
      continue;
    }

    let calledHere = 0;   // 这一家本轮叫了几次模型，见 MAX_CALLS_PER_AGENT
    let stop = false;     // 这一家本轮到此为止（模型挂了，或者到了调用上限）
    for (const f of all) {
      let lines;
      try {
        lines = (READERS[spec.format] || READERS.claude)(f);
      } catch (e) {
        // 这一轮跳过这个文件、水位不动，下次再读 —— 但**要说出来**。原来一声不吭地跳过，
        // 一个永远解析不了的 dsh 会话会让它的记录永远停着，auto.log 却显示一切正常（Codex 第七轮复核）。
        // dsh 正在重写会话文件的那一瞬间也会走到这里，偶尔出现一次是正常的；同一个文件反复出现才是问题。
        process.stderr.write(`scribe: 这一轮跳过读不了的会话 ${path.basename(f)}（${String(e.code || e.message).slice(0, 60)}）\n`);
        continue;
      }
      if (spec.format === 'dsh' && mark[LAYOUT]?.[f] !== 2) {
        if (typeof mark[f] === 'number') {
          // 旧水位还没换算（开头换算时这个文件读不了）：拿旧坐标去切新行会错位，这一轮不碰它
          process.stderr.write(`scribe: ${path.basename(f)} 的旧水位还没换算，这一轮跳过\n`);
          continue;
        }
        (mark[LAYOUT] ||= {})[f] = 2;   // 新会话没有旧坐标，直接按新切法记（和它的水位一起落盘）
      }
      const done = mark[f] ?? 0;
      const contEnd = mark[CONT]?.[f];
      if (lines.length <= done) {
        if (contEnd !== undefined) delete mark[CONT][f];   // 续做标记早该清掉了，留着没用
        continue;
      }
      // **续做只做到原窗口的终点**，不跟着文件末尾往后长。上一版每轮把终点延到当前末尾 ——
      // 一个一直在追加的会话可以永远处在续做里、每轮都不预筛，按家算的调用上限又让排在后面的文件永远轮不到
      // （Codex 第十轮复核注入复现：上限 2、连续 5 轮追加只读内容，第一个文件水位 2/4/6/8/10，后面的文件始终 0）。
      // 原窗口之后的内容下一轮当新窗口，照常预筛。
      const resuming = Number.isInteger(contEnd) && contEnd > done;
      const end = resuming ? Math.min(contEnd, lines.length) : lines.length;
      const units = unitsOf(spec.format, lines, done, end);

      // ①层预筛**按整个窗口**判，不逐段判：先读一大堆、最后才改一处是常态，逐段判会把前面那些段当成只读跳过。
      // **续做的窗口不再预筛**（见 CONT 的说明）：它整窗已经判过了，剩下的后缀单独看可能「没动过东西」或者很短。
      if (!resuming) {
        if (!units.some((u) => u.wrote)) {   // 没动过东西：不加载模型，水位越过整个窗口
          mark[f] = end;
          skipped += 1;
          continue;
        }
        if (joinText(units).length < MIN_WINDOW_CHARS && !idleFor(f, SHORT_FLUSH_IDLE_MS)) {
          // 太短：**水位不动**，等后面的内容攒上来一起看。原来是越过它 —— 可 dsh 的轮次概要被截断到
          // 提问 50 字、回答 120 字，单独一轮最多 177 字，而 dsh 每轮回复都触发一次扫描，每次只看到新的那一轮：
          // 永远不足 200 字、永远被越过（Codex 第十轮复核：本机 92 个会话里 19 个后续轮次全部不足 200 字）。
          // 但会话停住之后这段就不会再长了：**两小时没动静就照常送一次**。不送的话，dsh 会话最后单出来的一轮
          // 永远没人看（Codex 第十一轮复核：静止的短尾永远不提取）。
          skipped += 1;
          continue;
        }
      }
      // 从这里起这个窗口算「已接纳」：做到一半停下（失败 / 到上限 / 被杀），下一轮从水位接着做，不再预筛。
      (mark[CONT] ||= {})[f] = end;

      const chunks = splitChunks(units, done, (at, n) => process.stderr.write(
        `scribe: ${path.basename(f)} 第 ${at + 1} 行单独就有 ${n} 字，超过一次能喂的上限，只看了它的尾部\n`), budget);
      for (const chunk of chunks) {
        if (calledHere >= MAX_CALLS_PER_AGENT) {
          // 到上限：水位停在这一段的起点（上一段做完时已经存过），续做标记留着，下一轮接着做。
          capped += 1;
          stop = true;
          break;
        }
        const window = chunk.text;

        // 引证对不上时**重问一次**，把上次的错抄给它看。
        // 实测同一个 haiku 对同一份输入时而逐字抄、时而转述 —— 硬丢会不定期误杀真记忆，
        // 而水位已经推进，那一条就永久没了。
        // 这归 R10 的「规格故障」（模型活着，只是格式没对），改 prompt 重派是对的处理；
        // 403 / 超时那种「运行故障」仍然一次都不重试 —— 重试只会更快打爆额度。
        let got = null; let quotes = []; let modelQuotes = []; let bad = null; let failed = false; let last = null; let broke = false; let stuck = false;
        // 整段没有正文就不叫模型（续做时剩下的可能只是几条工具调用），直接当「没东西可记」走下去
        for (let attempt = 0; window && attempt < 2; attempt++) {
          // 重问也算一次调用，上限照样管。上一版只在段开头查，重问那次不查，上限 20 实际可能是 21（Codex 第十轮复核）。
          // 到上限时这一段没做完：水位不动，下一轮整段重来。
          if (attempt === 1 && calledHere >= MAX_CALLS_PER_AGENT) { broke = true; break; }
          called += 1;
          calledHere += 1;
          let raw;
          try {
            raw = runModel(spec, attempt === 0 ? SCRIBE_PROMPT(window) : RETRY_PROMPT(window, bad), agent);
          } catch (e) {
            // 提示送不出去（命令行装不下）：段已经按命令行预算切过（见 windowBudget），正常走不到这里。
            // 真走到了也**不跳过**：跳过就等于「模型看过、不值得记」，而这段一个字都没送出去（第十八轮 D：永久丢段）。
            // 这个文件停在这一段（水位不动、续做标记留着），其他文件照常做 —— 不熔断整家。
            if (CANDIDATE_ERRORS.has(e && e.code)) {
              process.stderr.write(`scribe: ${agent} 的 ${path.basename(f)} 第 ${chunk.start + 1} 行起这一段送不出去（${whyFailed(e)}），这个文件停在这里、水位不动\n`);
              stuck = true;
              break;
            }
            process.stderr.write(`scribe: ${agent} 的模型调用失败（${whyFailed(e)}）\n`);
            failed = true;
            break;
          }
          const g = parseLooseJson(raw);
          if (!g || g.worth !== true) { got = null; break; }   // 判定「不值得记」不重试
          got = g;
          last = g;                    // 留一份：下面把 got 置空后，留档还要靠它拿标题
          modelQuotes = asQuotes(g);
          const located = locateQuotes(modelQuotes, window);
          if (located) { quotes = located; break; }          // 往后交出去的是原文摘段，不是模型写的引文
          bad = modelQuotes.filter((q) => locateQuote(q, window) === null).join('\n---\n')
            || '（你根本没给 quotes，或者给了超过 3 段）';
          if (attempt === 1) got = null;                        // 重问一次还是对不上 → 认定编造
        }
        if (broke) {
          capped += 1;
          stop = true;
          break;
        }
        if (stuck) {
          mark[f] = chunk.start;
          stuckFiles += 1;
          break;
        }
        if (failed) {
          // **运行故障不许吃掉这段会话。** 水位退回到**这一段的起点**：前面已经做完的段保留，
          // 这一段和后面的下一轮接着做（续做标记留着，不会被重新预筛掉）。
          //
          // 原来这里是 `continue` —— 水位照推，这一窗永久跳过。2026-10-08 实测代价：
          // claude CLI 掉了登录（`Not logged in`），此后每段 claude 会话都在这里失败、被标成看过，
          // 而 auto.log 只写「调模型 1 次、新候选 0 条」，跟「没东西可记」一模一样。
          // R10：403 / 掉线 / 超时是运行故障，处理是「等冷却后原样重试」，不是当作看过。
          //
          // 同时**熔断这个 agent 本轮剩下的会话**（它们的水位一个都不碰）：
          // 模型挂了的时候接着试只会挨个失败 —— 断网时每个都要等满 MODEL_TIMEOUT_MS，
          // 20 个会话就是 100 分钟，auto 那一步早就被 30 分钟的时限杀掉了。
          mark[f] = chunk.start;
          fails += 1;
          stop = true;
          break;
        }
        // 这一段处理完了（产出候选、判定不值得记、被闸挡掉都算），水位推过它；整个窗口做完就清掉续做标记。
        // 两样都只改内存，和下面存水位那一步一起落盘。
        mark[f] = chunk.end;
        if (chunk.end >= mark[CONT][f]) delete mark[CONT][f];

        let keep = null;   // 要发布的候选；null = 这一段没有
        if (!got) {
          if (bad !== null) {
            // 留档：①层挡掉的东西不落盘，就没法回答「闸在干活还是在误杀」。
            const rd = path.join(ROOT, 'rejected');
            fs.mkdirSync(rd, { recursive: true });
            fs.writeFileSync(path.join(rd, `${crypto.randomUUID()}.json`), `${JSON.stringify({
              agent, model: spec.model, rejectedBy: 'script:quote',
              // 标题/正文也一并留下 —— 只记「引证对不上」而不记它想说什么，
              // 事后就分不清闸挡的是垃圾还是真记忆，而那正是留档要回答的问题。
              type: last && last.type, title: (last && last.title) || '(模型未给标题)',
              text: last && last.text,
              reason: '重问一次后引证在原文里仍逐字对不上', quote: bad, excerpt: window.slice(-3000),
            }, null, 2)}\n`, 'utf8');
            process.stderr.write(`scribe: [${agent}] 引证两次都对不上原文，丢弃\n`);
          }
        } else {
          const title = String(got.title || '').trim();
          const body = String(got.text || '').trim();
          if (title && body.length >= 12 && hasSpecifics(body)) {
            const near = await nearestMemory(ctx, title, body);
            if (near.exact) process.stdout.write(`  已记过（逐字相同），跳过：${title.slice(0, 40)}\n`);
            else keep = { title, body, similar: near.similar };
          }
        }
        if (!keep) {
          // 没有候选的段也要**马上**存水位。原来只改内存、整轮结束才存：中途被杀（auto 30 分钟到点）的话，
          // 这几段下一轮全部重问一遍（Codex 第九轮复核：前三段判「不值得记」之后杀掉，落盘水位还是 0，恢复后六段全部重问）。
          skipped += 1;
          saveMark(ROOT, mark);
          failpoint('scribe-after-checkpoint');
          continue;
        }

        // **发布候选是三步，顺序不能动：① 写 .tmp（里面记下它覆盖的窗口）→ ② 存水位 → ③ 改名成 .json。**
        // 任何两步之间被杀，留下的 .tmp 由下次 scribe 开头的 reconcileStaged 收拾 ——
        // 水位已越过它的窗口终点就补发布，能证明没越过就删掉（重跑会重新产出）。于是**恰好一次**：不丢也不重复。
        //
        // 这是第三次改这里，前两次都只是换了个缝：
        //   · 原来先发布、整轮结束才存水位：中途被杀，重跑把同一段再产一条（新 id）→ 两条都进库。
        //   · 改成「每产出一条就存水位」：缝缩到两次系统调用，Codex 第三轮复核注入照样打穿。
        //   · 再改成确定性 id（文件 + 窗口起始行）：重跑得到同一个 id 就不重复了 —— 可 Codex 第四轮复核
        //     指出，重跑时会话可能已经变长，窗口起点相同、内容更多，id 却一样 → 被当成「已进库」删掉，
        //     **多出来的那段永久丢失**。把「可能重复」换成了「可能丢失」，更糟。
        // 现在已发布的窗口永远不会被重跑，id 就用随机的，不再有撞 id 这回事。
        // .tmp 本身也保证 review 永远看不到写了一半的候选（review 只认 .json 结尾）。
        const id = crypto.randomUUID();
        const out = path.join(pendDir, `${id}.json`);
        fs.writeFileSync(`${out}.tmp`, `${JSON.stringify({
          id,
          ts: new Date().toISOString(),
          agent,                                   // 归属 = 产生这段会话的 agent，不是审核者
          model: spec.model,
          source: path.basename(f),
          sourceFile: f,                           // 和水位表的键同一个写法，reconcileStaged 靠它对账
          window: [chunk.start, chunk.end],        // 这条候选覆盖的行区间 [起, 止)
          // dsh 的行号是哪一套切法下的（见 reconcileStaged）。其他格式没换过切法，不写。
          layout: spec.format === 'dsh' ? 2 : undefined,
          // 库里很像的那条（≥ 0.96）：交给审核者判是不是同一件事（见 nearestMemory）
          similar: keep.similar || undefined,
          type: String(got.type || 'note'),
          title: keep.title,
          text: keep.body,
          quotes,                     // 原文摘段：按位置从 window 里原样摘出来的、带上下文（见 excerptOf），不是模型写的引文
          quoteFormat: QUOTE_FORMAT,  // 审核时靠它判断 quotes 能不能当事实（见 verifiedQuotes）
          modelQuotes,                // 模型自己写的引文，只留档：对照着看得出它改没改原话
          excerpt: window.slice(-EXCERPT_KEEP),   // 只留档，不喂给审核者（喂整窗实测会导致系统性误驳）
          windowSha: windowSha(window),           // 整段窗口的哈希：以后升版本重新摘段时核对内容（见 reextract）
        }, null, 2)}\n`, 'utf8');
        failpoint('scribe-after-stage');
        saveMark(ROOT, mark);
        failpoint('scribe-after-mark');
        fs.renameSync(`${out}.tmp`, out);
        made += 1;
        process.stdout.write(`  候选 [${agent}/${spec.model}] ${keep.title.slice(0, 46)}\n`);
      }
      if (stop) break;
    }
  }

  saveMark(ROOT, mark);
  // 失败数、到上限这两件事要进 **stdout 的总结行**：只写 stderr 的话，看总结的人（和 auto.log）分不出
  // 「调了模型但没东西可记」和「调了模型但模型挂了 / 还没做完」。
  process.stdout.write(`scribe 完成：新候选 ${made} 条，调模型 ${called} 次，跳过 ${skipped} 个窗口。`
    + `${fails ? `⚠ 其中 ${fails} 次调用失败，那些会话水位未推进，下次重扫。` : ''}`
    + `${capped ? `⚠ ${capped} 家到了本轮调用上限（每家 ${MAX_CALLS_PER_AGENT} 次），剩下的下一轮接着做。` : ''}`
    + `${stuckFiles ? `⚠ ${stuckFiles} 个会话有一段提示送不出去，停在那一段，水位未推进。` : ''}\n`);
}

// ---------------------------------------------------------------- 已有结论 / 遗留认领 / 坏文件
// 这条候选是不是已经有结论了。review **原地**处理 pending 里的候选：叫模型 → 写结论 → 删候选。
// 中途被杀，候选还在 pending，下次接着审；唯一要防的是「结论写完、删候选之前被杀」——
// 下次会再审、再写一遍（Codex 第一轮复核找到的：不需要任何并发，被杀一次就够）。
//
// 三条规矩，都是 Codex 第三轮复核注入复现过的：
//   · **按 id 认，log 和 rejected 一个口径。** 原来 log 按 id、rejected 按文件名查，同一个 id 的
//     两份候选可以一份被驳回、一份被通过，两种结局同时成立。
//   · **只认完整的记录。** 原来查子串，半截行 `{"id":"<uuid>",` 也算「已进库」，完整候选被删掉
//     → 丢失。现在 log 逐行解析（见 lib/jsonl.mjs），rejected 文件解析出 id 才算。
//   · **读不了就别往下走。** 原来吞掉读错误当成「没结论」，实测同一个 id 进库两次。
//     这里出错直接抛，调用方把候选留在 pending。
function alreadyDecided(ROOT, cand) {
  if (idInLogs(path.join(ROOT, 'log'), cand.id)) return '已进库';
  try {
    const r = JSON.parse(fs.readFileSync(rejectedPath(ROOT, cand), 'utf8'));
    if (r && r.id === cand.id) return '已驳回';
  } catch (e) {
    // 文件不存在 = 没被驳回；存在但解析不了 = 写到一半（旧版不是原子写）—— 也当没有，重审一次。
    if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
  }
  return null;
}

// 驳回留档按 **id** 命名，不按 pending 里的文件名 —— 同一个 id 的两份候选必须落到同一个结局上。
function rejectedPath(ROOT, cand) {
  return path.join(ROOT, 'rejected', `${cand.id}.json`);
}

// 旧版 review 先把候选改名成 `.claimed` 再处理；进程被杀时它就永远卡在那儿。
// 实测（2026-10-08 发现）：pending/ 里卡过 10 个，已被 10-08 当天的过渡版本接回，现在一个不剩。
// **不再自动接回。** 我上一版写的是「拿到 writer 锁时还在的认领，主人一定已经死了」——
// Codex 第三轮复核推翻了：旧版 review **不拿这把锁**，升级那一刻正在跑的旧进程、手动跑的旧副本，
// 都可能是活着的主人；接回它就是两边一起提交（实测：同一个 id 两条 log，或者 log 和 rejected 同时有）。
// 现在只报出来、在 `memo pending` 里列出来，由人确认没有旧进程在跑之后去掉 `.claimed` 后缀。
function countLegacyClaims(pendDir) {
  try { return fs.readdirSync(pendDir).filter((f) => f.endsWith('.claimed')).length; } catch { return 0; }
}

// 读不出来的候选挪成 `.corrupt`，**不删**。原来是直接删，Codex 第二轮复核实测打出过
// 「review 读到写了一半的候选 → 判坏删掉 → 候选永久丢失」。现在 scribe 先写临时文件再改名、
// 且和 review 互斥，读到半截的路已经堵死；还读不出来的就是真坏了，留着给人看。
function quarantine(fpath) {
  try { fs.renameSync(fpath, `${fpath}.corrupt`); } catch { /* 挪不动就留在原地 */ }
}

// ---------------------------------------------------------------- review
// 审核者 = 环形下一家。两个 agent 时就是互审；以后加回 kimi/dsh 自动变成四元环。
// 环从「当前配置里存在的 agent」现算，不写死 —— 删掉 Gemini 这件事说明这个列表会变。
function reviewerOf(scribes, author) {
  const names = Object.keys(scribes);
  if (names.length < 2) return null;
  const i = names.indexOf(author);
  return names[(i + 1) % names.length];
}

export async function cmdReview(ctx, args) {
  const { ROOT } = ctx;
  // **writer 锁：同一时刻只有一个 scribe 或 review 在改 pending / log。**
  //
  // 最早的事故：两个 review 相隔 1 秒，都读到同一个候选、都叫了模型，三条记忆各进库两遍、id 相同。
  // 当时的修法是「原子改名认领」，后来为了处理认领卡死，又一层层加了：按 mtime 回收、认领名加
  // 随机后缀、写之前确认认领还是自己的、改名前后各刷一次 mtime。那一整套是在让**并发的** review
  // 互相协商，每补一层都还剩一个更窄的窗口，Codex 复核都用注入时序打穿了。不让它们并发，
  // 那些窗口就都不存在了，认领也就不需要了。
  // （`memo add` / `forget` 不拿这把锁，见 bin/memo.mjs 的说明。）
  if (!(await takeWriterLock(ROOT, 'review'))) return;
  const scribes = loadScribes(ROOT);
  assertNoPersist(scribes);
  const pendDir = path.join(ROOT, 'pending');
  const logDir = path.join(ROOT, 'log');

  const legacy = countLegacyClaims(pendDir);
  if (legacy) {
    process.stdout.write(`⚠ pending 里有 ${legacy} 个旧版 review 留下的 .claimed，没有自动接回`
      + '（主人可能还活着）。用 memo pending 查看；确认没有旧版在跑之后去掉 .claimed 后缀。\n');
  }

  let files;
  try { files = fs.readdirSync(pendDir).filter((f) => f.endsWith('.json')); } catch { files = []; }
  if (!files.length) { process.stdout.write('没有待审候选。\n'); return; }

  const limit = Number(args.limit) > 0 ? Number(args.limit) : files.length;
  let accepted = 0; let rejected = 0; let held = 0; let cleaned = 0;
  const fails = new Map();     // 审核者 → 连续运行失败了几次（成功一次清零）
  const failMs = new Map();    // 审核者 → 本轮失败的调用累计花了多久（不清零，见 REVIEW_FAIL_BUDGET_MS）
  const down = new Map();      // 本轮熔断了的审核者 → 之后跳过了几条
  const deadline = Date.now() + REVIEW_BUDGET_MS;   // 过了这个时刻不再开始新的模型调用
  let late = 0;                // 因为到点没审的
  const sources = new Map();   // 重新摘段时读过的会话文件（同一个会话的候选常常好几条，读一次）

  for (const fname of files.slice(0, limit)) {
    const fpath = path.join(pendDir, fname);
    let cand;
    try {
      cand = JSON.parse(fs.readFileSync(fpath, 'utf8'));
      if (!cand || typeof cand.id !== 'string' || !cand.id) throw new Error('没有 id');
    } catch {
      quarantine(fpath);
      process.stderr.write(`review: ${fname} 读不出来，挪成 .corrupt 留给人看\n`);
      continue;
    }

    // 上次死在「写结论」和「删候选」之间：结论已经在了，删掉候选就好，**不能再审一遍**。
    let decided;
    try {
      decided = alreadyDecided(ROOT, cand);
    } catch (e) {
      process.stderr.write(`review: 判断「${String(cand.title).slice(0, 24)}」有没有结论时读文件失败`
        + `（${String(e && (e.code || e.message)).slice(0, 60)}），留在 pending\n`);
      held += 1;
      continue;
    }
    if (decided) {
      fs.rmSync(fpath, { force: true });
      cleaned += 1;
      process.stdout.write(`  · ${decided}，清理：${String(cand.title).slice(0, 40)}\n`);
      continue;
    }

    // 下面所有「不处理」的出口都不用做任何事：候选原地留在 pending，下次接着审（fail-closed）。
    const who = reviewerOf(scribes, cand.agent);
    const spec = who && scribes[who];
    if (!spec) {
      process.stderr.write(`review: ${cand.agent} 找不到异族审核者，留在 pending\n`);
      held += 1;
      continue;
    }

    // 熔断：同一个审核者**连续** REVIEW_TRIP 次运行失败，它负责的剩下这些直接留着，本轮不再叫。
    // 2026-10-10 真实库：dsh 的接口一直报 502，review 对着它连撞了 100 多次，每次都要等它失败，
    // 30 分钟的步骤时限被耗光，codex 那边本来能审的候选也审不完。
    // 只数「审核者本身」的失败：提示拼不出来、提示超长这类**这一条候选**的问题只扣下这一条，不计数；
    // 中间成功一次就清零（第十七轮复核：第一次失败就熔断，一条坏候选能让好好的审核者整轮停摆）。
    // 另外两道：同一个审核者失败累计耗时到预算也熔断（失败和成功交替时连续计数总被清零，第十八轮 C）；
    // 整轮到点就不再开始新的调用，剩下的原地留到下一轮。
    if (down.has(who)) { held += 1; down.set(who, down.get(who) + 1); continue; }
    if (Date.now() >= deadline) { held += 1; late += 1; continue; }

    let prompt;
    try {
      prompt = REVIEW_PROMPT(reextract(cand, scribes, sources));
    } catch (e) {
      process.stderr.write(`review: 「${String(cand.title).slice(0, 24)}」拼不出审核提示（${whyFailed(e)}），留在 pending\n`);
      held += 1;
      continue;
    }
    let raw;
    const t0 = Date.now();
    try {
      raw = runModel(spec, prompt, who);
    } catch (e) {
      // fail-closed：审核者不可用 → 候选原样留在 pending，等下次。
      // 这里**绝不能**默认放行，那等于整套审核不存在。
      held += 1;
      if (CANDIDATE_ERRORS.has(e && e.code)) {
        process.stderr.write(`review: 「${String(cand.title).slice(0, 24)}」的提示送不出去（${whyFailed(e)}），只扣下这一条\n`);
        continue;
      }
      const n = (fails.get(who) || 0) + 1;
      const ms = (failMs.get(who) || 0) + (Date.now() - t0);
      fails.set(who, n);
      failMs.set(who, ms);
      const trip = n >= REVIEW_TRIP ? `连续 ${n} 次失败` : ms >= REVIEW_FAIL_BUDGET_MS ? `失败累计 ${Math.round(ms / 1000)} 秒` : '';
      process.stderr.write(`review: 审核者 ${who} 不可用（${whyFailed(e)}），候选留在 pending`
        + `${trip ? `；${trip}，本轮不再叫它` : ''}\n`);
      if (trip) down.set(who, 0);
      continue;
    }
    fails.set(who, 0);

    const verdict = parseLooseJson(raw);
    if (!verdict || typeof verdict.accept !== 'boolean') {   // 判不出也不放行
      held += 1;
      continue;
    }

    // 先写结论、再删候选。反过来的话，中间被杀就是候选没了、结论也没有 —— 丢；
    // 这个顺序中间被杀，下次 alreadyDecided 会认出来。
    if (verdict.accept) {
      // 通过才进 log —— 索引只吃 log，所以「通过」和「可被检索」是同一件事。
      const rec = {
        id: cand.id,
        ts: cand.ts,
        agent: cand.agent,
        cwd: '',
        type: cand.type,
        title: cand.title,
        text: cand.text,
        tags: ['auto', `by:${cand.model}`, `ok:${who}`],
      };
      if (process.env.AGENTMEM_FAILPOINT === 'review-torn-log') {
        // 模拟「追加写到一半被杀」：只写半行、不换行就退出。见 failpoint 的说明。
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(path.join(logDir, `${cand.agent}.jsonl`), JSON.stringify(rec).slice(0, 60), 'utf8');
        process.exit(86);
      }
      if (process.env.AGENTMEM_FAULT === 'commit-torn') {
        // 模拟「这次追加被拆开、中间插进了别人的写入」：只落下半条、但**正常返回**。见下面的回读确认。
        fs.appendFileSync(path.join(logDir, `${cand.agent}.jsonl`), `\n${JSON.stringify(rec).slice(0, 60)}`, 'utf8');
      } else {
        appendRecord(path.join(logDir, `${cand.agent}.jsonl`), rec);
      }
      failpoint('review-after-commit');
      // **回读确认自己那条完整进去了，才删候选。** 删候选不可逆，而「一次追加 = 一个连续的块」这个前提
      // 不保证成立：Node 的 appendFileSync 遇到短写会分几次写，中间可能插进不拿锁的 memo add，
      // 这条记录就被拆成两半、谁也解析不了（Codex 第七轮复核用等价模型复现；本机 NTFS 上会不会自然发生
      // 没有验证过）。确认不到就把候选留着，下次重审 —— 判重只认完整记录，不会因为这半条就当成已进库。
      let landed = false;
      try { landed = idInFile(path.join(logDir, `${cand.agent}.jsonl`), cand.id); } catch { /* 读不了就当没确认到 */ }
      if (!landed) {
        process.stderr.write(`review: 「${String(cand.title).slice(0, 30)}」写进 log 后回读不到完整记录，候选留着下次重审\n`);
        held += 1;
        continue;
      }
      fs.rmSync(fpath, { force: true });
      accepted += 1;
      process.stdout.write(`  ✓ [${cand.agent}→${who}] ${cand.title.slice(0, 44)}\n`);
    } else {
      // 驳回留档不删：以后想知道「闸到底挡掉了什么」只能靠这些。
      // 先写临时文件再改名：rejected 文件「存在」就意味着「写完了」，alreadyDecided 才敢信它。
      const rp = rejectedPath(ROOT, cand);
      fs.mkdirSync(path.dirname(rp), { recursive: true });
      fs.writeFileSync(`${rp}.tmp`,
        `${JSON.stringify({ ...cand, rejectedBy: who, reason: String(verdict.reason || '') }, null, 2)}\n`, 'utf8');
      fs.renameSync(`${rp}.tmp`, rp);
      failpoint('review-after-commit');
      fs.rmSync(fpath, { force: true });
      rejected += 1;
      process.stdout.write(`  ✗ [${cand.agent}→${who}] ${cand.title.slice(0, 34)} —— ${String(verdict.reason || '').slice(0, 30)}\n`);
    }
  }
  process.stdout.write(`review 完成：通过 ${accepted}，驳回 ${rejected}，留待重试 ${held}`
    + `${cleaned ? `，清理已有结论的 ${cleaned}` : ''}`
    + `${[...down].map(([w, n]) => `；审核者 ${w} 本轮不可用，跳过 ${n} 条`).join('')}`
    + `${late ? `；本轮到时间了，${late} 条没开始审` : ''}。\n`);
}

// ---------------------------------------------------------------- pending
export function cmdPending(ctx) {
  const { ROOT } = ctx;
  const show = (dir, label) => {
    let fs2;
    try { fs2 = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.json')); } catch { return 0; }
    for (const f of fs2) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'));
        process.stdout.write(`${label} [${c.agent}/${c.model}] ${String(c.title).slice(0, 50)}`
          + `${c.reason ? `  —— ${String(c.reason).slice(0, 34)}` : ''}\n`);
      } catch { /* 坏文件跳过 */ }
    }
    return fs2.length;
  };
  const p = show('pending', '待审');
  // 遗留认领和坏文件也要列出来：它们不以 .json 结尾，上面那个 show 看不见，
  // 而卡死的认领恰恰是最需要被看见的 —— 那 10 个就是对这个命令隐形了两周。
  let k = 0; let bad = 0;
  try {
    for (const f of fs.readdirSync(path.join(ROOT, 'pending'))) {
      if (f.endsWith('.corrupt')) {
        // 两种隔离要分开说：读不出来的是真坏了；读得出来的是「判断不了提交没提交」，内容完整、可能要人工接回
        // （原来一律叫「读不出来的坏文件」，Codex 第十三轮复核指出会误导恢复。接回步骤见 README）。
        bad += 1;
        let c = null;
        try { c = JSON.parse(fs.readFileSync(path.join(ROOT, 'pending', f), 'utf8')); } catch { /* 真坏了 */ }
        // 「内容完整」要真是一条候选（有 id 的对象）；能解析但不是候选的（null、数组、没 id）也算坏文件
        const isCand = c && typeof c === 'object' && !Array.isArray(c) && typeof c.id === 'string' && c.id;
        process.stdout.write(isCand
          ? `隔离 ${f} [${c.agent}] ${String(c.title).slice(0, 40)}（内容完整，判断不了提交没提交；接回前先核对，见 README）\n`
          : `坏文件 ${f}（${c === null ? '读不出来' : '不是候选的格式'}，留给人看）\n`);
        continue;
      }
      if (!f.endsWith('.claimed')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'pending', f), 'utf8'));
        process.stdout.write(`遗留认领 [${c.agent}/${c.model}] ${String(c.title).slice(0, 44)}`
          + '  —— 旧版 review 留下的，不会自动接回；确认没有旧版在跑之后去掉 .claimed 后缀\n');
        k += 1;
      } catch { /* 坏文件跳过 */ }
    }
  } catch { /* 没有 pending 目录 */ }
  const r = show('rejected', '驳回');
  if (!p && !r && !k && !bad) process.stdout.write('没有待审，也没有被驳回的。\n');
  else process.stdout.write(`\n待审 ${p} 条，遗留认领 ${k} 条，隔离或坏文件 ${bad} 个，历史驳回 ${r} 条。\n`);
}
