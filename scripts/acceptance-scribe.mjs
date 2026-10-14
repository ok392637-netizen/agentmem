// scribe / review 的验收。全部走真实 CLI 子进程 + 临时 AGENTMEM_HOME。
//
// 模型一律用桩（stub.mjs），三个理由：
//   1. 不烧额度；2. 结果确定，测的是管道不是模型；
//   3. 能测「模型崩了」「模型吐垃圾」这些真模型不肯配合演的失败。
//
// 但**桩会掩盖一类错误**：我的解析器和我的假数据可能一起错。
// 所以第 9 条拿磁盘上真实的 transcript 跑提取器，不用假数据。
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 按脚本自己的位置推算仓库：原来写死成主仓库的路径，在 worktree / 副本里跑时测的其实是主仓库的代码
const REPO = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO, 'bin', 'memo.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmem-scribe-'));
const CT = path.join(HOME, 'ct');   // 假 claude transcript 目录
const XT = path.join(HOME, 'xt');   // 假 codex   transcript 目录
const STUB = path.join(HOME, 'stub.mjs');
const MODE = path.join(HOME, 'stub-mode.txt');
const CALLS = path.join(HOME, 'stub-calls.log');

fs.mkdirSync(CT, { recursive: true });
fs.mkdirSync(XT, { recursive: true });

const results = [];
const ok = (n, pass, detail) => {
  results.push({ n, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}\n      ${detail}`);
};

// ---------------------------------------------------------------- 桩模型
// argv[2] = 被当成哪个 agent 的模型调的（用来验「审核者 ≠ 作者」）。
// 每次调用都记一行，于是「有没有叫模型」「叫了谁」都可断言。
fs.writeFileSync(STUB, `
import fs from 'node:fs';
const who = process.argv[2];
fs.appendFileSync(${JSON.stringify(CALLS)}, who + '\\n');
const mode = fs.readFileSync(${JSON.stringify(MODE)}, 'utf8').trim();
const input = fs.readFileSync(0, 'utf8');
const isReview = input.includes('【待审记忆】');
// 把两种调用各自收到的 prompt 落盘，供「审核者看到的源 == scribe 看到的窗口」那条断言比对
fs.writeFileSync(${JSON.stringify(HOME)} + (isReview ? '/last-review.txt' : '/last-scribe.txt'), input, 'utf8');
// 配置里带 {prompt} 时提示还会经命令行再来一份（dsh 就是这样收的）：留底，好核对它和 stdin 那份一字不差
const argvPrompt = process.argv.slice(3).find((a) => a.includes('【'));
if (argvPrompt !== undefined) fs.writeFileSync(${JSON.stringify(HOME)} + '/argv-prompt.txt', argvPrompt, 'utf8');
// 每一次 scribe 调用的输入都追加留底：大窗口分段之后，要看「每一段都真的交给了模型」，只看最后一次不够
if (!isReview) fs.appendFileSync(${JSON.stringify(HOME)} + '/all-scribe.txt', input + '\\n=====\\n', 'utf8');
if (mode === 'crash') { process.stderr.write('模型炸了\\n'); process.exit(1); }
// crash-codex：只有 codex 挂（另一个审核者好好的）；crash-odd-codex：codex 第 1、3、5… 次挂，中间那几次正常
if (mode === 'crash-codex' && who === 'codex') { process.stderr.write('codex 炸了\\n'); process.exit(1); }
// hang-odd-codex：codex 第 1、3、5… 次卡住不返回（由 runModel 的超时杀掉），中间那几次正常 —— 测失败累计耗时熔断
if (mode === 'hang-odd-codex' && who === 'codex'
  && fs.readFileSync(${JSON.stringify(CALLS)}, 'utf8').split('\\n').filter((w) => w === 'codex').length % 2 === 1) {
  const t = Date.now(); while (Date.now() - t < 20000);
}
// quote-huge：第一次给一段 35000 字、原文里根本没有的引文；重问时判不值得记 —— 测重问提示里的错引文有上限
if (mode === 'quote-huge' && !isReview) {
  const retry = input.includes('你刚才给的引证');
  process.stdout.write(JSON.stringify(retry ? { worth: false, type: '', title: '', text: '', quotes: [] }
    : { worth: true, type: 'pitfall', title: '坑：超长引文', text: '判据 a.js', quotes: ['编'.repeat(35000)] }) + '\\n');
  process.exit(0);
}
if (mode === 'crash-odd-codex' && who === 'codex'
  && fs.readFileSync(${JSON.stringify(CALLS)}, 'utf8').split('\\n').filter((w) => w === 'codex').length % 2 === 1) {
  process.stderr.write('codex 这次炸了\\n'); process.exit(1);
}
// crash-gbk：像 cmd.exe 那样用 GBK 报错（「系统找不到指定的文件。」的 GBK 字节）
if (mode === 'crash-gbk') { process.stderr.write(Buffer.from('CFB5CDB3D5D2B2BBB5BDD6B8B6A8B5C4CEC4BCFEA1A3', 'hex')); process.exit(1); }
// crash-2line：原因在第一行、第二行只是折行的尾巴（cmd.exe 的「不是内部或外部命令」就是这样）
// 第一行故意很长（超过 200 字）：先拼首末再截 200 的写法会把第二行整个挤掉
if (mode === 'crash-2line') { process.stderr.write('第一行：真正的原因在这里' + '细节'.repeat(110) + '\\n第二行：只是尾巴\\n'); process.exit(1); }
// crash-after-1：第一次调用正常，从第二次起都失败 —— 用来测「分段后第二段失败，水位只退回到第二段」
if (mode === 'crash-after-1' && fs.readFileSync(${JSON.stringify(CALLS)}, 'utf8').split('\\n').filter(Boolean).length >= 2) {
  process.stderr.write('第二次起模型炸了\\n'); process.exit(1);
}
if (mode === 'garbage') { process.stdout.write('我觉得吧，这个不太好说……没有 JSON。\\n'); process.exit(0); }
if (mode === 'worthless' && !isReview) {
  process.stdout.write(JSON.stringify({ worth: false, type: '', title: '', text: '', quotes: [] }) + '\\n');
  process.exit(0);
}
if (isReview) {
  // slow-review：拖慢审核，把「读候选 → 叫模型 → 写 log」之间的窗口撑开，
  // 好让并发测试真的撞上去。不拖的话两个进程很可能前后脚跑完，测不到竞态。
  if (mode === 'slow-review') { const t = Date.now(); while (Date.now() - t < 1500); }
}
// gate：真正的同步屏障。每次调用按进来的先后原子领号（ticket-1、ticket-2…，wx 创建），
// 测试预先放了 hold-N 的那一号就写 entered-N 然后停住，直到测试删掉 hold-N。
// 为什么不用上面那种「拖 1.5 秒」：Codex 复核指出那不是屏障 —— 慢机器上后来的进程可能
// 根本没赶上窗口，测试照样通过，**假绿**。屏障让「谁停在哪、谁先醒」完全由测试决定。
// gate 模式除了屏障，其余行为同 accept（scribe 照常产候选，review 判通过）。
if (mode === 'gate') {
  let n = 1;
  for (;; n++) { try { fs.writeFileSync(${JSON.stringify(HOME)} + '/ticket-' + n, '', { flag: 'wx' }); break; } catch {} }
  const hold = ${JSON.stringify(HOME)} + '/hold-' + n;
  if (fs.existsSync(hold)) {
    fs.writeFileSync(${JSON.stringify(HOME)} + '/entered-' + n, '');
    const nap = new Int32Array(new SharedArrayBuffer(4));
    const t = Date.now();
    while (fs.existsSync(hold) && Date.now() - t < 120000) Atomics.wait(nap, 0, 0, 20);
    // 等满还没被放行 = 测试自己写错了。**大声失败**，不能当作放行接着跑 ——
    // Codex 第二轮复核指出：屏障到点自动放行，测试就可能在异常情况下静默通过。
    if (fs.existsSync(hold)) { process.stderr.write('gate 超时：测试没有放行\\n'); process.exit(3); }
  }
}
// reject-once：第一次审核判驳回、之后都判通过 —— 用来测「同一个 id 的两份候选不能一份驳回一份通过」。
const rejectNow = mode === 'reject' || (mode === 'reject-once' && isReview && (() => {
  try { fs.writeFileSync(${JSON.stringify(HOME)} + '/rejected-once', '', { flag: 'wx' }); return true; } catch { return false; }
})());
if (isReview) {
  const verdict = rejectNow
    ? { accept: false, reason: '只是流水账，没有可复用的判据' }
    : { accept: true, reason: '忠实于源片段且给了具体判据' };
  process.stdout.write('先想一想……\\n' + JSON.stringify(verdict) + '\\n');
} else if (mode === 'dup' || mode === 'dup-nospace') {
  // 故意吐一条和库里已有记忆逐字相同的，用来验①层去重闸。
  // dup-nospace：只把正文里「memo add」中间那个空格去掉 —— 不是同一段文字，不该被当成逐字相同。
  // 引证也要给真的 —— 否则会先被引证闸拦下，根本走不到去重那一步。
  const w = input.split('【会话片段】')[1] || '';
  const text = '现象出在 memo add 卡住了一直不返回；判据 readFileSync(0) 在永不关闭的管道上一直等，改 --stdin。';
  process.stdout.write(JSON.stringify({ worth: true, type: 'pitfall',
      title: '坑：memo add 卡住了一直不返回',
      text: mode === 'dup' ? text : text.replace('memo add', 'memoadd'),
      quotes: [w.trim().slice(0, 120)] }) + '\\n');
} else {
  // 候选必须**跟着输入变**，否则每条候选都一样，去重闸会把后面的全挡掉，
  // 「驳回」「检索不到」这些分支就永远测不到。
  const m = input.split('【会话片段】')[1] || '';
  const key = (m.match(/用户：(.+)/) || [,'未知'])[1].trim().slice(0, 30);
  // 正常情况下逐字抄一段原文当引证；fabricate 两次都编，fabricate-once 只第一次编。
  // 「是不是重问」直接看 prompt 里有没有纠正语，这样连重试用的 prompt 也一起测到了。
  const isRetry = input.includes('你刚才给的引证');
  const fake = mode === 'fabricate' || (mode === 'fabricate-once' && !isRetry);
  // 两段引证：一段真、一段按 mode 决定真假 —— 顺带验「有一段假就整条作废」
  // quote-ab：把原话里的 "a b" 抄成 "ab"（改了值）；quote-fake-tail：真实前缀后面接一个编造的「…9999」
  const quotes = fake
    ? [m.trim().slice(0, 60), '这段话在原文里根本不存在，是我自己编出来充当证据的一句话。']
    // quote-file：引文直接从测试写好的文件里读，好精确构造反例（省略否定、截断数字、同一个值出现两次）
    : mode === 'quote-file' ? JSON.parse(fs.readFileSync(${JSON.stringify(path.join(HOME, 'quotes.json'))}, 'utf8'))
    : mode === 'quote-ab' ? [m.trim().slice(0, 60).replace('"a b"', '"ab"')]
    : mode === 'quote-fake-tail' ? [m.trim().slice(0, 60) + '…9999']
    : [m.trim().slice(0, 60), m.trim().slice(60, 180)];
  // accept-fffd：废话里夹一个字面的 �（合法 UTF-8）—— 不能因此把整段当 GBK 解坏
  process.stdout.write('让我分析一下这段对话。\\n嗯，确实有个坑。\\n' + (mode === 'accept-fffd' ? '（这里有个 � 字符）\\n' : '')
    + JSON.stringify({ worth: true, type: 'pitfall',
        title: '坑：' + key,
        text: '现象出在 ' + key + '；判据 readFileSync(0) 在永不关闭的管道上一直等，改 --stdin。',
        quotes }) + '\\n');
}
`, 'utf8');
fs.writeFileSync(MODE, 'accept', 'utf8');

// ---------------------------------------------------------------- 配置
// 桩也必须带上「不落盘」开关 —— runModel 对它是硬拦截，不带就不许调。
// 桩本身不认这个参数，但它就该在这里：测试用的命令行和真实的必须同构，
// 否则「真实配置漏了开关」这件事测试根本碰不到。
const NO_PERSIST = { claude: '--no-session-persistence', codex: '--ephemeral' };
// 「不许用工具」的参数同理（见 scribe.mjs 的 NO_TOOLS）：桩不认，但真实配置漏了它们必须被拦下
const NO_TOOLS_ARGS = {
  claude: ['--tools', '', '--strict-mcp-config', '--permission-mode', 'dontAsk'],
  codex: ['-s', 'read-only'],
};
const runOf = (who) => ['node', STUB, who, NO_PERSIST[who], ...NO_TOOLS_ARGS[who]];
fs.writeFileSync(path.join(HOME, 'scribes.json'), JSON.stringify({
  claude: { model: 'stub', format: 'claude', transcripts: [path.join(CT, '*.jsonl')], run: runOf('claude') },
  codex: { model: 'stub', format: 'codex', transcripts: [path.join(XT, '*.jsonl')], run: runOf('codex') },
}, null, 2), 'utf8');

// ---------------------------------------------------------------- 夹具
// 助手那段要够长：scribe 有 200 字的窗口下限（太短的窗口没有可记的东西），
// 而真实会话的一轮远不止一句话。夹具短于真实值会把测试变成假绿。
const FILLER = '我先复现了一下，然后逐个排查了调用链上的几个位置，确认问题不在参数解析那一层，'
  + '而是在进程的输入端。改完之后重新跑了一遍，现象消失，边界情况也一并试过了。'
  + '顺带把相邻的两处同型写法也一并核对过，确认它们走的不是同一条路径，因此不受影响。'
  + '另外补了一条断言把这个行为钉住，先看到它是红的，再改实现让它变绿，避免写完就绿等于没断言到任何东西。'
  + '最后重跑了整套验收，确认没有把别的地方碰坏。';

const claudeTurn = (text, tools = []) => [
  JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), cwd: 'C:\\x', message: { role: 'user', content: text } }),
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: `好的，我看一下。${FILLER}` },
      ...tools.map(name => ({ type: 'tool_use', name, input: {} }))] },
  }),
].join('\n') + '\n';

const codexTurn = (text, tool) => [
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'agent_message', content: [{ type: 'input_text', text: `明白了。${FILLER}` }] } }),
  ...(tool ? [JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: tool, input: 'x' } })] : []),
].join('\n') + '\n';

const CT_FILE = path.join(CT, 'sess1.jsonl');
const XT_FILE = path.join(XT, 'rollout-a.jsonl');

function memo(args, agent = 'claude') {
  return execFileSync(process.execPath, [CLI, ...args], {
    // 模型缓存指向机器上那一份：临时 HOME 每次都是空的，跟着它走会每跑一次验收重下 130MB
    env: {
      ...process.env,
      AGENTMEM_HOME: HOME,
      AGENTMEM_AGENT: agent,
      AGENTMEM_MODEL_CACHE: 'C:\\Users\\bokily\\.agentmem\\model-cache',
    },
    encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
const countDir = (d) => { try { return fs.readdirSync(path.join(HOME, d)).length; } catch { return 0; } };
const countLog = (a) => { try { return fs.readFileSync(path.join(HOME, 'log', `${a}.jsonl`), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const calls = () => { try { return fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const resetCalls = () => fs.rmSync(CALLS, { force: true });

// ---- 1. 冷启动不回溯：历史里有一堆可记的东西，--init 后必须一条都不产
fs.writeFileSync(CT_FILE, claudeTurn('历史上的坑一', ['Edit']) + claudeTurn('历史上的坑二', ['Write']), 'utf8');
memo(['scribe', '--init']);
resetCalls();
const out1 = memo(['scribe']);
ok('1 冷启动不回溯历史', countDir('pending') === 0 && calls().length === 0,
  `--init 后水位=文件末尾；再跑 scribe 产出 ${countDir('pending')} 条、调模型 ${calls().length} 次。${out1.trim().split('\n')[0] || ''}`);

// ---- 2. 窗口内没有写操作 → 根本不叫模型（①层预筛，零成本）
fs.appendFileSync(CT_FILE, claudeTurn('帮我看看这个文件写了啥', ['Read']), 'utf8');
resetCalls();
memo(['scribe']);
ok('2 无写操作的窗口不叫模型', calls().length === 0 && countDir('pending') === 0,
  `只含 Read 的窗口：调模型 ${calls().length} 次、产出 ${countDir('pending')} 条`);

// ---- 3. 有写操作 → 叫模型并产出候选；且模型输出前面有废话也要能解析出来
// 两家各喂一段**内容不同**的会话：内容相同的话第二条会被去重闸挡掉，测不到环形。
fs.appendFileSync(CT_FILE, claudeTurn('memo add 卡住了一直不返回', ['Edit', 'Bash']), 'utf8');
fs.writeFileSync(XT_FILE, codexTurn('libsql 的 all 返回裸 ArrayBuffer 导致向量全零', 'apply_patch'), 'utf8');
resetCalls();
memo(['scribe']);
const pend1 = countDir('pending');
ok('3 两家都产出候选 + 容错解析', calls().sort().join() === 'claude,codex' && pend1 === 2,
  `调模型 ${calls().length} 次（${calls().sort().join('/')}）；桩在 JSON 前吐了两行废话，仍解析出 ${pend1} 条候选`);

// ---- 4. 环形两个方向都必须是**异族**：claude 的归 codex 审，codex 的归 claude 审
const authorOf = {};
for (const f of fs.readdirSync(path.join(HOME, 'pending'))) {
  const c = JSON.parse(fs.readFileSync(path.join(HOME, 'pending', f), 'utf8'));
  authorOf[c.agent] = c.title;
}
resetCalls();
const revOut = memo(['review']);
const reviewers = calls().sort().join();
const arrows = [...revOut.matchAll(/\[(\w+)→(\w+)\]/g)].map(m => `${m[1]}→${m[2]}`).sort();
ok('4 环形两个方向都是异族审核',
  reviewers === 'claude,codex' && arrows.join() === 'claude→codex,codex→claude'
  && arrows.every(a => a.split('→')[0] !== a.split('→')[1]),
  `作者=${Object.keys(authorOf).sort().join('/')}；实际走向 ${arrows.join('  ') || '无'}；无人审自己`);

// ---- 5. 通过则各自进**自己**的 log（归属是作者不是审核者），且能被 recall 检索到
const recalled = memo(['recall', '管道 stdin 阻塞']);
ok('5 通过后按作者归属进 log 且可检索',
  countLog('claude') === 1 && countLog('codex') === 1 && countDir('pending') === 0 && recalled.includes('memo add'),
  `log/claude ${countLog('claude')} 条、log/codex ${countLog('codex')} 条，pending 清空；`
  + `recall 命中：${recalled.trim().split('\n')[0].slice(0, 46)}`);

// ---- 6. 驳回：不进 log，进 rejected，recall 查不到
// 这条同时是**去重闸不过度触发**的证据：桩的两条候选共享一半样板（实测余弦 0.9506），
// 讲的却是不同的事。它必须活着走到审核那一步，而不是在①层就被当成重复吃掉。
fs.writeFileSync(MODE, 'reject', 'utf8');
fs.appendFileSync(CT_FILE, claudeTurn('把 README 端口 3000 改成 3001', ['Edit']), 'utf8');
memo(['scribe']);
memo(['review']);
const rejOut = memo(['recall', '端口 3001']);
ok('6 驳回不进 log 且检索不到', countLog('claude') === 1 && countDir('rejected') === 1 && !rejOut.includes('3001'),
  `log 仍 ${countLog('claude')} 条，rejected ${countDir('rejected')} 条，recall「端口 3001」未命中被驳回的那条`);

// ---- 7. fail-closed：审核者崩了，候选必须留在 pending，绝不默认放行
fs.writeFileSync(MODE, 'accept', 'utf8');
fs.appendFileSync(CT_FILE, claudeTurn('FTS5 trigram 分词器三字符才命中', ['Edit']), 'utf8');
memo(['scribe']);
const beforeLog = countLog('claude');
fs.writeFileSync(MODE, 'crash', 'utf8');
memo(['review']);
ok('7 审核者不可用时 fail-closed', countDir('pending') === 1 && countLog('claude') === beforeLog,
  `审核模型退出码非 0：候选留在 pending ${countDir('pending')} 条，log 未增加（仍 ${countLog('claude')} 条）`);

// ---- 8. 模型吐垃圾（无 JSON）→ 丢弃该候选，不重试、不崩
fs.writeFileSync(MODE, 'garbage', 'utf8');
fs.appendFileSync(CT_FILE, claudeTurn('又一个坑', ['Write']), 'utf8');
resetCalls();
let crashed = false;
try { memo(['scribe']); } catch { crashed = true; }
ok('8 模型输出无 JSON 时丢弃且不崩', !crashed && calls().length === 1,
  `scribe 正常退出=${!crashed}，且只调了 ${calls().length} 次（不重试）`);

// ---- 9. ①层去重闸：模型吐出一条和库里逐字相同的，必须在叫审核之前就被挡掉
fs.writeFileSync(MODE, 'dup', 'utf8');
fs.appendFileSync(CT_FILE, claudeTurn('再说一次那个卡住的事', ['Edit']), 'utf8');
const pendBefore = countDir('pending');
const dupOut = memo(['scribe']);
ok('9 已记过的内容被①层去重挡掉', countDir('pending') === pendBefore && dupOut.includes('已记过'),
  `pending 未增加（仍 ${countDir('pending')} 条），输出：${(dupOut.match(/已记过.*/) || ['无'])[0].slice(0, 46)}`);

// ---- 10. 拿磁盘上**真实**的 transcript 跑提取器
// 前九条全用假数据，而假数据可能和我的解析器**一起错**。
// 所以这条把配置临时换成真实路径（默认配置），只跑提取不叫模型。
fs.writeFileSync(MODE, 'accept', 'utf8');
const SCFG = path.join(HOME, 'scribes.json');
const savedCfg = fs.readFileSync(SCFG, 'utf8');
fs.rmSync(SCFG);                       // 删掉 → 下次运行会写回内置默认配置（真实路径）
const probe = memo(['scribe', '--probe']);
fs.writeFileSync(SCFG, savedCfg, 'utf8');
const mClaude = probe.match(/claude\s+(\d+)\s*字/);
const mCodex = probe.match(/codex\s+(\d+)\s*字/);
ok('10 真实 transcript 能被提取出正文',
  !!mClaude && Number(mClaude[1]) > 500 && !!mCodex && Number(mCodex[1]) > 500,
  `从真实文件提取：claude ${mClaude ? mClaude[1] : '?'} 字 / codex ${mCodex ? mCodex[1] : '?'} 字（阈值 500）`);

// ---- 11. 编造的引证必须被①层脚本挡掉（变异测试：把引证换成原文里没有的话）
// 这条替代了「审核者能不能看出编造」—— 实测便宜模型在一万多字的源里找证据会漏，
// 把 13 次出现的词判成「源片段未提及」，于是**真实的记忆被系统性误驳**。
// 所以「引证是否出自原文」下沉成字符串比对，归脚本、零信任，不再问模型。
const rejEntries = () => {
  try {
    return fs.readdirSync(path.join(HOME, 'rejected')).map(f =>
      JSON.parse(fs.readFileSync(path.join(HOME, 'rejected', f), 'utf8')));
  } catch { return []; }
};
fs.rmSync(path.join(HOME, 'pending'), { recursive: true, force: true });  // 清掉第 7 条留下的
fs.writeFileSync(MODE, 'fabricate', 'utf8');
fs.appendFileSync(CT_FILE, claudeTurn('WAL 模式没开导致并发写 sqlite 直接锁死', ['Write']), 'utf8');
resetCalls();
memo(['scribe']);
const byScript = rejEntries().filter(r => r.rejectedBy === 'script:quote');
ok('11 两次都编造 → ①层脚本挡掉并留档', countDir('pending') === 0 && calls().length === 2 && byScript.length === 1,
  `重问了一次（共调 ${calls().length} 次）仍对不上 → pending ${countDir('pending')} 条，`
  + `rejected 里留下 ${byScript.length} 条 script:quote 记录`);

// ---- 12. 第一次编造、重问后照抄 → 必须救回来
// 实测同一个 haiku 对同一份输入时而照抄时而转述。没有这次重试，真记忆会被不定期误杀，
// 而水位已推进、那一条就永久丢了。
fs.writeFileSync(MODE, 'fabricate-once', 'utf8');
fs.appendFileSync(CT_FILE, claudeTurn('presence 的 TTL 定成 15 分钟而不是定时清理', ['Write']), 'utf8');
resetCalls();
memo(['scribe']);
ok('12 重问一次后引证对上 → 候选救回', countDir('pending') === 1 && calls().length === 2,
  `第一次编造被拒、第二次照抄通过（共调 ${calls().length} 次）→ pending ${countDir('pending')} 条`);

// ---- 13. 「不值得记」不触发重试 —— 否则每个无聊窗口都要烧两次额度
fs.writeFileSync(MODE, 'accept', 'utf8');
fs.rmSync(path.join(HOME, 'pending'), { recursive: true, force: true });
fs.appendFileSync(XT_FILE, codexTurn('顺手把变量名 tmp 改成 buf', 'apply_patch'), 'utf8');
fs.writeFileSync(MODE, 'worthless', 'utf8');
resetCalls();
memo(['scribe']);
ok('13 判定「不值得记」时不重试', calls().length === 1 && countDir('pending') === 0,
  `模型答 worth=false → 只调 ${calls().length} 次，没有第二次`);

// ---- 14. run 里缺「不落盘」开关时必须拒绝调用（回归：这个坑真的踩了）
// 少了它，scribe 每问一次就在用户的会话列表里留一条「你是记忆记录员…」，
// 而且那些会话落在 ~/.claude/projects/ 下 —— 正是 scribe 自己要扫的目录，会回流。
// 实测两天开发就塞进去 27 条 claude 会话 + 23 个 codex rollout。
// 污染是**静默**的：不报错、不变慢，等被发现时已经几十条了，所以做成硬拦截而不是警告。
const cfgPath = path.join(HOME, 'scribes.json');
const goodCfg = fs.readFileSync(cfgPath, 'utf8');
const broken = JSON.parse(goodCfg);
broken.claude.run = ['node', STUB, 'claude'];          // 故意拿掉开关
fs.writeFileSync(cfgPath, JSON.stringify(broken, null, 2), 'utf8');
fs.rmSync(path.join(HOME, 'pending'), { recursive: true, force: true });
fs.appendFileSync(CT_FILE, claudeTurn('索引坏了直接删掉重建而不是增量修复', ['Write']), 'utf8');
let guardMsg = '';
try { guardMsg = memo(['scribe']); } catch (e) { guardMsg = String(e.stdout || '') + String(e.stderr || ''); }
const blocked = countDir('pending') === 0 && /no-session-persistence/.test(guardMsg);
fs.writeFileSync(cfgPath, goodCfg, 'utf8');            // 复原
ok('14 缺「不落盘」开关时拒绝调模型', blocked,
  `拿掉 --no-session-persistence → 不产出候选且报出缺失项；`
  + `提示：${(guardMsg.match(/缺 --[a-z-]+/) || ['无'])[0]}`);

// ---- 14b. 缺「不许用工具」的参数时同样拒绝调模型（scribe 和 review 走同一个检查，这里测 scribe）
// 2026-10-12 事故：scribe 叫的 claude -p 带着全部工具，对着会话片段里的一份复核报告改了 agentmem 自己的代码。
// claude 拿掉 --tools ""、codex 拿掉 -s read-only，各测一次；只看「不产出候选 + 报出缺哪个 + 一次模型都没叫」。
const toolCases = [
  ['claude', (r) => r.filter((x, i) => !(x === '--tools' || (x === '' && r[i - 1] === '--tools')))],
  ['codex', (r) => r.filter((x, i) => !(x === '-s' || (x === 'read-only' && r[i - 1] === '-s')))],
].map(([who, strip]) => {
  const cfg = JSON.parse(goodCfg);
  cfg[who].run = strip(cfg[who].run);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  fs.rmSync(path.join(HOME, 'pending'), { recursive: true, force: true });
  fs.appendFileSync(who === 'claude' ? CT_FILE : XT_FILE, who === 'claude'
    ? claudeTurn(`缺工具开关时不许跑 ${who}`, ['Write']) : codexTurn(`缺工具开关时不许跑 ${who}`, 'apply_patch'), 'utf8');
  resetCalls();
  const r = spawnSync(process.execPath, [CLI, 'scribe'], {
    env: { ...process.env, AGENTMEM_HOME: HOME, AGENTMEM_AGENT: 'claude', AGENTMEM_MODEL_CACHE: 'C:\\Users\\bokily\\.agentmem\\model-cache' },
    encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const said = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(cfgPath, goodCfg, 'utf8');
  const want = who === 'claude' ? /claude 缺 --tools ""/ : /codex 缺 -s read-only/;
  return [who, countDir('pending') === 0 && calls().length === 0 && want.test(said), said.match(/缺 [^；。\n]+/)?.[0] || '没报缺失'];
});
memo(['scribe']);                                        // 复原配置后把上面追加的两轮正常做掉，别留给后面
fs.rmSync(path.join(HOME, 'pending'), { recursive: true, force: true });
ok('14b 缺「不许用工具」的参数时拒绝调模型（claude 的 --tools ""、codex 的只读沙盒）', toolCases.every(([, pass]) => pass),
  toolCases.map(([who, pass, msg]) => `${who}：拦下=${pass}（${msg}）`).join('；'));

// ---- 15. 两个 review 同时跑，同一个候选只能进库一次（回归：真的重复了）
// 原先流程是「读 pending → 叫模型（30 秒）→ 写 log → 删文件」，那 30 秒里
// 另一个进程会读到同一个候选。实测 auto.mjs 有两次运行相隔 1 秒，
// 结果三条记忆各被写了两遍、id 完全相同。
// 修法：最早是原子改名认领；2026-10-08 换成 writer 锁 —— 两个 review 根本不会同时跑，
// 后到的那个直接让路（见第 22 条和 lib/scribe.mjs 的 cmdReview）。这条照样得过。
fs.writeFileSync(MODE, 'accept', 'utf8');
fs.rmSync(path.join(HOME, 'pending'), { recursive: true, force: true });
fs.appendFileSync(CT_FILE, claudeTurn('presence 用读时 TTL 过滤而不是定时清理任务', ['Write']), 'utf8');
memo(['scribe']);
const before15 = countLog('claude');
fs.writeFileSync(MODE, 'slow-review', 'utf8');
const { execFile } = await import('node:child_process');
const { promisify } = await import('node:util');
const pExec = promisify(execFile);
const oneReview = () => pExec(process.execPath, [CLI, 'review'], {
  env: {
    ...process.env, AGENTMEM_HOME: HOME, AGENTMEM_AGENT: 'claude',
    AGENTMEM_MODEL_CACHE: 'C:/Users/bokily/.agentmem/model-cache',
  },
  cwd: REPO,
}).catch(e => e);
await Promise.all([oneReview(), oneReview()]);
const gained = countLog('claude') - before15;
const leftover = fs.existsSync(path.join(HOME, 'pending'))
  ? fs.readdirSync(path.join(HOME, 'pending')).length : 0;
ok('15 并发审核同一候选只进库一次', gained === 1 && leftover === 0,
  `两个 review 进程同抢一个候选：log 增加 ${gained} 条（必须是 1），pending 残留 ${leftover} 个`);

// ---- 16. forget：记错的能撤回，且原始日志只追加不改写
// 2026-09-23 实测发现：**系统会忠实记下我说错的话**。我把一个路径分隔符引起的误判
// 当成结论说了出来，scribe 照抄，引证闸逐字核对**通过**（那句话我确实说了），
// 异族审核也放行（它判不了被引用的那句话本身是错的）。于是假记忆进库，
// 而当时整套系统没有任何撤回手段 —— 这条测的就是补上的那个口子。
const logPath = path.join(HOME, 'log', 'claude.jsonl');
const readLines = () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
const beforeLines = readLines().length;
const victim = JSON.parse(readLines()[0]);
memo(['forget', victim.id, '--reason', '前提是错的']);
memo(['reindex']);
const afterLines = readLines().length;
const gone = !memo(['recall', victim.title.slice(0, 12), '--limit', '8']).includes(victim.title);
ok('16 forget 撤回记错的记忆，日志只追加不改写',
  gone && afterLines === beforeLines + 1,
  `recall 已查不到「${victim.title.slice(0, 18)}」=${gone}；`
  + `日志 ${beforeLines} → ${afterLines} 行（+1 条墓碑，原记录留着）`);

// ================================================================ 2026-10-08 那次事故的回归
// claude CLI 掉了登录 → scribe 每次调用都失败 → 水位照推、会话永久跳过 → auto.log 一片绿。
// 同期还挖出：锁接管不刷新（互斥失效）、被杀掉的 review 留下永远卡死的认领。
const AUTO = path.join(REPO, 'bin', 'auto.mjs');
const PEND = path.join(HOME, 'pending');
const autoEnv = {
  ...process.env, AGENTMEM_HOME: HOME, AGENTMEM_AGENT: 'claude',
  AGENTMEM_MODEL_CACHE: 'C:/Users/bokily/.agentmem/model-cache',
};
// 直接跑 worker（--worker 跳过「甩到后台」那一步），这样能同步等它跑完。
const autoWorker = () => execFileSync(process.execPath, [AUTO, '--worker', '--agent', 'claude'],
  { env: autoEnv, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
const autoLog = () => { try { return fs.readFileSync(path.join(HOME, 'auto.log'), 'utf8'); } catch { return ''; } };
const waitFor = async (cond, ms = 15000) => {
  const t = Date.now();
  while (!cond() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 30));
  return cond();
};
const claims = () => { try { return fs.readdirSync(PEND).filter((f) => f.endsWith('.claimed')); } catch { return []; } };
const jsons = () => { try { return fs.readdirSync(PEND).filter((f) => f.endsWith('.json')); } catch { return []; } };

// ---- 17. 模型调用失败必须在 auto.log 里看得见，且同一 agent 本轮熔断
// 两段会话都有新内容；模型一挂，第一段失败后第二段不该再试（断网时每段都要等满超时）。
fs.rmSync(PEND, { recursive: true, force: true });
fs.rmSync(path.join(HOME, 'auto.log'), { force: true });
const CT_FILE2 = path.join(CT, 'sess2.jsonl');
fs.appendFileSync(CT_FILE, claudeTurn('模型挂了的时候水位不能推进', ['Edit']), 'utf8');
fs.writeFileSync(CT_FILE2, claudeTurn('第二段会话也有可记的东西', ['Write']), 'utf8');
fs.writeFileSync(MODE, 'crash', 'utf8');
resetCalls();
autoWorker();
const log17 = autoLog();
// 「模型炸了」是桩自己写进 stderr 的原因。只看到「调用失败」不够 —— 曾有一次 claude
// 失败就是只记了「Command failed + 命令行」，事后完全查不出为什么。
ok('17 模型调用失败在 auto.log 里看得见（含原因）+ 本轮熔断',
  log17.includes('模型调用失败') && log17.includes('模型炸了') && /其中 1 次调用失败/.test(log17) && calls().length === 1,
  `失败进了 auto.log=${log17.includes('模型调用失败')}；模型自己说的原因也在=${log17.includes('模型炸了')}；`
  + `总结行带失败数=${/其中 \d+ 次调用失败/.test(log17)}；两段会话只试了 ${calls().length} 次（应为 1）`);

// ---- 18. 模型恢复后，失败时没处理的会话被补扫 —— 一段都不能丢
fs.writeFileSync(MODE, 'accept', 'utf8');
resetCalls();
memo(['scribe']);
ok('18 模型恢复后两段会话都被补扫', calls().length === 2 && jsons().length === 2,
  `恢复后调模型 ${calls().length} 次、产出候选 ${jsons().length} 条（都应为 2；旧逻辑水位已推进，会是 0）`);

// ---------------------------------------------------------------- 第 19 条起的共用件
// 这几条直接往 pending 里放候选，**不走 scribe**。第一版走了 scribe，结果有一条没产出候选、
// `jsons()[0]` 是 undefined 直接崩了 —— 桩的正文是同一个模板，库里同类条目一多，新候选就被
// ①层去重判成「已记过」。这几条测的是 review，不该被 scribe 的去重牵连。
// plant 顺带清空 pending：旧代码上前一条失败留下的残留，曾让后面的 `waitFor` 被**立刻满足**，
// 于是那几条在旧代码上「通过」了 —— 测的根本不是设计的场景。
const plant = (title, { keep = false } = {}) => {
  if (!keep) fs.rmSync(PEND, { recursive: true, force: true });
  fs.mkdirSync(PEND, { recursive: true });
  const id = crypto.randomUUID();
  const q = `${title}：这是一段逐字出自会话的引证，用来让审核者有东西可看。`;
  const p = path.join(PEND, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify({
    id, ts: new Date().toISOString(), agent: 'claude', model: 'stub', source: 'planted.jsonl',
    type: 'pitfall', title, text: `${title}。判据：进程被杀之后，下一个持锁的进程把它没做完的接着做完。`,
    quotes: [q], excerpt: q,
  }, null, 2), 'utf8');
  return p;
};
// 屏障（见桩里的 gate 模式）：hold(n) 让第 n 个进来的模型调用停住，open(n) 放行。
// **数模型调用看 ticket-N，不看 entered-N**：entered 只在设了 hold 的那一号才写，
// 拿它判断「有没有第二次调用」是无效断言（Codex 第三轮复核实测：调了两次，entered-2 仍是 false）。
const gate = {
  reset: () => { for (const f of fs.readdirSync(HOME)) if (/^(ticket|hold|entered)-\d+$|^rejected-once$/.test(f)) fs.rmSync(path.join(HOME, f), { force: true }); },
  hold: (n) => fs.writeFileSync(path.join(HOME, `hold-${n}`), ''),
  open: (n) => fs.rmSync(path.join(HOME, `hold-${n}`), { force: true }),
  entered: (n) => fs.existsSync(path.join(HOME, `entered-${n}`)),
  called: (n) => fs.existsSync(path.join(HOME, `ticket-${n}`)),
};
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);
const exited = (child) => new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once('exit', r); });
// 这个 id 在 log/ 里有几条**完整、能解析**的记录。半截行不算 —— 判断标准和 review 自己的一致。
const idCount = (id) => {
  let n = 0;
  let names = [];
  try { names = fs.readdirSync(path.join(HOME, 'log')).filter((f) => f.endsWith('.jsonl')); } catch { return 0; }
  for (const f of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(HOME, 'log', f), 'utf8'); } catch { continue; }   // 第 27 条故意放了个读不了的
    for (const l of text.split('\n')) {
      try { if (JSON.parse(l).id === id) n += 1; } catch { /* 半截行 */ }
    }
  }
  return n;
};
const rejectedHas = (id) => fs.existsSync(path.join(HOME, 'rejected', `${id}.json`));
const idOf = (p) => JSON.parse(fs.readFileSync(p, 'utf8')).id;
const reviewChild = () => spawn(process.execPath, [CLI, 'review'], { env: autoEnv, cwd: REPO, stdio: 'ignore' });
// 带故障注入点跑一次 review：进程会在注入点直接退出（退出码 86），所以吞掉报错。
const reviewWithFault = (fp) => {
  try {
    execFileSync(process.execPath, [CLI, 'review'], {
      env: { ...autoEnv, AGENTMEM_FAILPOINT: fp }, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 0;
  } catch (e) { return e.status; }
};

// ---- 19. 一阵触发同时撞上一把陈旧的旧式锁，只能有一个 worker 干活
// 复现 Codex 找到的那串竞态：N 个进程都在任何人刷新之前读到旧时间 → N 个一起「接管」。
// 真实触发里见过 1 秒 5 次（auto.log 08:53:49），所以就打 5 个。
// auto.lock 目录是旧版留下的残骸（2 小时前）；新锁是命名管道，根本不看它。
fs.writeFileSync(MODE, 'accept', 'utf8');
memo(['scribe']);                                   // 先把没扫的会话扫干净，worker 里的 scribe 就不会调模型
const planted19 = plant('一阵触发里只能有一个人干活');  // 给 review 一条候选，让赢家停在屏障里
const id19 = idOf(planted19);
const LOCKP = path.join(HOME, 'auto.lock');
fs.mkdirSync(LOCKP, { recursive: true });
fs.utimesSync(LOCKP, hoursAgo(2), hoursAgo(2));
fs.rmSync(path.join(HOME, 'auto.log'), { force: true });
fs.writeFileSync(MODE, 'gate', 'utf8');
gate.reset(); gate.hold(1);
const burst = [1, 2, 3, 4, 5].map(() => pExec(process.execPath, [AUTO, '--worker', '--agent', 'claude'],
  { env: autoEnv, cwd: REPO }).catch((e) => e));
const in19 = await waitFor(() => gate.entered(1));
const all19 = await waitFor(() => (autoLog().match(/已有一个 auto 在跑/g) || []).length >= 4, 20000);
const second19 = gate.called(2);                    // 赢家还停在屏障里时，有没有别人叫了模型
gate.open(1);
await Promise.all(burst);
const log19 = autoLog();
const ran19 = (log19.match(/^\[review\]/gm) || []).length;
const yielded19 = (log19.match(/已有一个 auto 在跑/g) || []).length;
ok('19 一阵触发撞上陈旧锁，只有一个 worker 干活',
  in19 && all19 && ran19 === 1 && yielded19 === 4 && !second19 && idCount(id19) === 1,
  `5 个 worker 同时起：真正跑了 review 的 ${ran19} 个（应为 1），让路 ${yielded19} 个（应为 4）；`
  + `赢家停在屏障里=${in19}；那期间别人也叫了模型=${second19}（应为 false）；进库 ${idCount(id19)} 次（应为 1）`);

// ---- 20. 持锁的 worker 被强杀，下一个立刻能拿到锁，并把它没做完的那条做完
// 旧的目录锁这里会让后来者等满 30 分钟：锁目录还在，时间是新的。
// **A 的屏障在 B 跑的全程都不放开**（Codex 第三轮复核指出：原版先放行 A 再起 B，
// A 底下的 review 要是没跟着死，提交的其实是 A，测试照样通过）。B 的模型调用领的是 2 号，不受阻拦；
// B 做完之后才放开 1 号 —— 那时要是 A 还活着，它会再提交一次，进库次数就会变成 2。
fs.rmSync(path.join(HOME, 'auto.log'), { force: true });
const planted20 = plant('持锁的进程死了锁要立刻释放');
const id20 = idOf(planted20);
fs.writeFileSync(MODE, 'gate', 'utf8');
gate.reset(); gate.hold(1);
const A20 = spawn(process.execPath, [AUTO, '--worker', '--agent', 'claude'], { env: autoEnv, cwd: REPO, stdio: 'ignore' });
const in20 = await waitFor(() => gate.entered(1));
A20.kill();                                         // TerminateProcess：退出处理一行都不会跑
await exited(A20);
try { autoWorker(); } catch { /* B 的结局看日志和 log */ }
const log20 = autoLog();
const bCommitted = /通过 1/.test(log20) && !/已有一个 auto 在跑|让路/.test(log20);
const afterB20 = idCount(id20);
gate.open(1);                                       // 现在才放开 A 的屏障：A 要是没死，它会接着提交
await new Promise((r) => setTimeout(r, 1500));
ok('20 持锁的 worker 被强杀后，下一个立刻接手并做完', in20 && bCommitted && afterB20 === 1 && idCount(id20) === 1,
  `A 停在屏障里=${in20}；A 被强杀后 B 拿到锁并提交=${bCommitted}；`
  + `B 之后进库 ${afterB20} 次、放开 A 的屏障后 ${idCount(id20)} 次（都应为 1）`);

// ---- 21. 旧版留下的认领（`.claimed`）不自动接回，但看得见
// 上一版自动接回，理由是「拿到锁时还在的认领，主人一定死了」—— Codex 第三轮复核推翻：
// 旧版 review 不拿这把锁，升级那一刻活着的旧进程就是反例（实测两边一起提交）。
fs.writeFileSync(MODE, 'accept', 'utf8');
const planted21 = plant('旧版留下的认领不自动接回');
const id21 = idOf(planted21);
fs.renameSync(planted21, `${planted21}.claimed`);
const pend21 = memo(['pending']);
const out21 = memo(['review']);
ok('21 遗留认领不自动接回，但报出来', pend21.includes('遗留认领') && /没有自动接回/.test(out21)
  && fs.existsSync(`${planted21}.claimed`) && idCount(id21) === 0,
  `memo pending 列出=${pend21.includes('遗留认领')}；review 报出=${/没有自动接回/.test(out21)}；`
  + `认领原样还在=${fs.existsSync(`${planted21}.claimed`)}；进库 ${idCount(id21)} 次（应为 0）`);

// ---- 22. writer 锁：一个 review 正在跑时，另一个 review 和 scribe 都让路，不碰它的东西
// 这一条替掉了原来测「认领」的三条：那三条测的都是**并发的** review 怎么协商，现在它们不会并发。
// 只看输出里有没有「让路」不够（Codex 第三轮复核：让 scribe 忽略拿锁失败接着跑，输出里「让路」和
// 「scribe 完成」同时出现，测试照样通过）。所以给 scribe 准备了新会话，并且要求：
// 输出里**没有**「scribe 完成」，屏障期间**没有**第二次模型调用。
fs.writeFileSync(MODE, 'gate', 'utf8');
gate.reset(); gate.hold(1);
const planted22 = plant('一个 review 在跑时别人都让路');
const id22 = idOf(planted22);
fs.appendFileSync(CT_FILE, claudeTurn('writer 锁在的时候 scribe 不许动', ['Edit']), 'utf8');
const A22 = oneReview();
const in22 = await waitFor(() => gate.entered(1));   // A 拿着 writer 锁、停在模型调用里
const outB22 = memo(['review']);
const outS22 = memo(['scribe']);
const quiet22 = !gate.called(2) && fs.existsSync(planted22);
gate.open(1);
await A22;
ok('22 review 在跑时别的 review/scribe 让路，一步都不走',
  in22 && /让路/.test(outB22) && /让路/.test(outS22) && !/scribe 完成/.test(outS22) && quiet22 && idCount(id22) === 1,
  `A 停在屏障里=${in22}；B(review) 让路=${/让路/.test(outB22)}；scribe 让路且没往下跑=${/让路/.test(outS22) && !/scribe 完成/.test(outS22)}；`
  + `期间没有别的模型调用、A 的候选没被动=${quiet22}；进库 ${idCount(id22)} 次（应为 1）`);
fs.writeFileSync(MODE, 'accept', 'utf8');
memo(['scribe']);                                   // 把刚才给 scribe 准备的那段会话处理掉，别留给后面的测试

// ---- 23. review 被强杀：候选从没离开过 pending，下一个 review 接着审
// 原来的认领机制下，这里会留一个永远没人管的 `.claimed`（就是那 10 个的来历）。
fs.writeFileSync(MODE, 'gate', 'utf8');
gate.reset(); gate.hold(1);
const planted23 = plant('review 被杀了候选不能丢');
const id23 = idOf(planted23);
const A23 = reviewChild();
const in23 = await waitFor(() => gate.entered(1));
A23.kill();
await exited(A23);
gate.open(1);
const still23 = fs.existsSync(planted23);
fs.writeFileSync(MODE, 'accept', 'utf8');
memo(['review']);
ok('23 review 被强杀后候选还在，下一个接着审', in23 && still23 && idCount(id23) === 1 && countDir('pending') === 0,
  `A 停在屏障里=${in23}；A 被杀后候选仍在 pending=${still23}；下一个 review 审完进库 ${idCount(id23)} 次（应为 1）`);

// ---- 24. 「写完 log、删候选之前」被杀：下次必须直接清理，**不能再审一遍**
// Codex 第一轮复核找到的重复路径：不需要任何并发，在这两步之间被杀一次就够。用故障注入点真的杀在那里。
fs.writeFileSync(MODE, 'accept', 'utf8');
const planted24 = plant('写完结论但没来得及删候选');
const id24 = idOf(planted24);
const code24 = reviewWithFault('review-after-commit');
const mid24 = idCount(id24) === 1 && fs.existsSync(planted24);
resetCalls();
const out24 = memo(['review']);
ok('24 提交后被杀，下次只清理不重审', code24 === 86 && mid24 && idCount(id24) === 1 && calls().length === 0 && countDir('pending') === 0,
  `注入点退出码 ${code24}（应为 86）；被杀时 log 已有、候选还在=${mid24}；`
  + `下次调模型 ${calls().length} 次（应为 0），进库 ${idCount(id24)} 次（应为 1）；${(out24.match(/· [^\n]*/) || ['(没清理)'])[0].slice(0, 30)}`);

// ---- 25. 驳回同理：「写完 rejected、删候选之前」被杀，下次换成会判通过的审核者也不能翻案
fs.writeFileSync(MODE, 'reject', 'utf8');
const planted25 = plant('驳回写完但没来得及删候选');
const id25 = idOf(planted25);
const code25 = reviewWithFault('review-after-commit');
fs.writeFileSync(MODE, 'accept', 'utf8');
resetCalls();
memo(['review']);
ok('25 驳回后被杀，下次不翻案', code25 === 86 && rejectedHas(id25) && idCount(id25) === 0 && calls().length === 0 && countDir('pending') === 0,
  `注入点退出码 ${code25}；已驳回=${rejectedHas(id25)}；下次调模型 ${calls().length} 次（应为 0），进库 ${idCount(id25)} 次（应为 0）`);

// ---- 26. log 只写了半行就被杀：那半行不算「已进库」，候选必须重审、完整地进库一次
// Codex 第三轮复核：原来查子串，半截行 `{"id":"<uuid>",` 也算命中 → 删掉完整候选 → 丢失。
// 另一半问题：下一条记录不能接在半截行后面（那样两条一起坏掉）。
const planted26 = plant('log 写到一半被杀');
const id26 = idOf(planted26);
const code26 = reviewWithFault('review-torn-log');
const torn26 = fs.readFileSync(path.join(HOME, 'log', 'claude.jsonl'), 'utf8');
const tornTail = !torn26.endsWith('\n') && torn26.includes(id26);
memo(['review']);
ok('26 半截行不算进库，重审后完整进库一次', code26 === 86 && tornTail && idCount(id26) === 1 && countDir('pending') === 0,
  `注入点留下了半截行=${tornTail}；重审后完整记录 ${idCount(id26)} 条（应为 1）；pending 剩 ${countDir('pending')}`);

// ---- 26b. 追加结论时被拆开（中间插进了别人的写入），但进程**正常返回** —— 不能删候选
// 和第 26 条不同：那是进程被杀；这里进程活着、以为写成了。Node 的 appendFileSync 遇到短写会分几次写，
// 中间能插进不拿锁的 memo add（Codex 第七轮复核用等价模型复现）。删候选不可逆，所以写完要回读确认。
const planted26b = plant('结论被拆开写进 log');
const id26b = idOf(planted26b);
fs.writeFileSync(MODE, 'accept', 'utf8');
const r26b = spawnSync(process.execPath, [CLI, 'review'], {
  env: { ...autoEnv, AGENTMEM_FAULT: 'commit-torn' }, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
});
// 必须真的走到「写坏了但正常返回」：退出码 0、log 里确实落下了半条、并且报出了回读失败。
// 只看「候选还在」不够（Codex 第八轮复核：把故障分支改成追加之前就退出 1，原版这条照样通过）。
const halfLanded = (() => {
  try { return fs.readFileSync(path.join(HOME, 'log', 'claude.jsonl'), 'utf8').split('\n').some((l) => l.includes(id26b) && !(() => { try { JSON.parse(l); return true; } catch { return false; } })()); } catch { return false; }
})();
const kept26b = r26b.status === 0 && halfLanded && /回读不到完整记录/.test(r26b.stderr) && fs.existsSync(planted26b) && idCount(id26b) === 0;
memo(['review']);
ok('26b 结论被拆开写进 log：候选留着，下次重审后完整进库一次', kept26b && idCount(id26b) === 1 && countDir('pending') === 0,
  `第一次退出码 ${r26b.status}（应为 0）、落下了半条=${halfLanded}、报出回读失败=${/回读不到完整记录/.test(r26b.stderr)}、`
  + `候选还在=${fs.existsSync(planted26b) || idCount(id26b) === 1}；下次重审后完整记录 ${idCount(id26b)} 条（应为 1）`);

// ---- 27. 读不了 log 时不许往下走：判断不了「有没有结论」，就不能提交
// Codex 第三轮复核：原来吞掉读错误当成「没结论」，实测同一个 id 进库两次。
// 用一个叫 *.jsonl 的**目录**制造读失败（EISDIR）—— 在 Windows 上造 EIO 不现实，判据是同一条代码路径。
const planted27 = plant('读不了 log 的时候不能提交');
const id27 = idOf(planted27);
const bogus27 = path.join(HOME, 'log', 'zz-unreadable.jsonl');
fs.mkdirSync(bogus27, { recursive: true });
resetCalls();
const out27 = memo(['review']);
const held27 = /留待重试 1/.test(out27) && fs.existsSync(planted27) && idCount(id27) === 0 && calls().length === 0;
fs.rmSync(bogus27, { recursive: true, force: true });
ok('27 读不了 log 时候选留在 pending，不提交', held27,
  `留待重试=${/留待重试 1/.test(out27)}；候选还在=${fs.existsSync(planted27)}；进库 ${idCount(id27)} 次、调模型 ${calls().length} 次（都应为 0）`);
fs.rmSync(PEND, { recursive: true, force: true });

// ---- 27b. 审核者连续挂了两次，它负责的剩下那些本轮不再叫（熔断）—— 但只熔断它，也只认它自己的失败
// 2026-10-10 真实库：dsh 的接口一直报 502，review 对着它连撞 100 多次，30 分钟的步骤时限被耗光。
// Codex 第十七轮复核：第一次失败就熔断，一条坏候选（提示拼不出、提示超长）能让好好的审核者整轮停摆。
// 文件名带序号前缀：pending 按目录顺序处理，顺序不定的话「坏候选在前」这个场景就不一定发生。
const plantAs = (name, agent, extra = {}) => {
  fs.mkdirSync(PEND, { recursive: true });
  const id = crypto.randomUUID();
  const q = `${name}：这是一段逐字出自会话的引证，用来让审核者有东西可看。`;
  fs.writeFileSync(path.join(PEND, `${name}.json`), JSON.stringify({
    id, ts: new Date().toISOString(), agent, model: 'stub', source: 'planted.jsonl', type: 'pitfall',
    title: `熔断 ${name}`, text: `熔断 ${name}。判据：同一个审核者连续两次运行失败才本轮不再叫它。`, quotes: [q], excerpt: q, ...extra,
  }, null, 2), 'utf8');
};
const whoCalled = (w) => calls().filter((c) => c === w).length;
const runReview = (env = {}) => spawnSync(process.execPath, [CLI, 'review'], {
  env: { ...autoEnv, ...env }, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
});
// (a) codex 一直挂：叫两次就停，第三条留着；claude 审的那条照常审完
fs.rmSync(PEND, { recursive: true, force: true });
for (const n of ['a1', 'a2', 'a3']) plantAs(n, 'claude');   // claude 写的 → codex 审
plantAs('a4', 'codex');                                     // codex 写的 → claude 审
fs.writeFileSync(MODE, 'crash-codex', 'utf8');
resetCalls();
const r27a = runReview();
const n27a = [whoCalled('codex'), whoCalled('claude')];
const a27 = n27a[0] === 2 && n27a[1] === 1 && jsons().length === 3 && /审核者 codex 本轮不可用，跳过 1 条/.test(r27a.stdout);
// (b) 失败之间夹着成功：连续计数要清零，四条都要审到
fs.rmSync(PEND, { recursive: true, force: true });
for (const n of ['b1', 'b2', 'b3', 'b4']) plantAs(n, 'claude');
fs.writeFileSync(MODE, 'crash-odd-codex', 'utf8');
resetCalls();
const r27b = runReview();
const n27b = whoCalled('codex');
const b27 = n27b === 4 && jsons().length === 2 && !/本轮不可用/.test(r27b.stdout);
// (c) 坏候选在前：提示拼不出（quotes 不是数组）、提示超长（审核者经命令行收提示）—— 只扣下它们，不算审核者挂了。
// 后面两条好候选照样要叫两次模型（这次模型真挂，所以叫满两次才熔断）。
fs.rmSync(PEND, { recursive: true, force: true });
const cfg27 = fs.readFileSync(path.join(HOME, 'scribes.json'), 'utf8');
const argvCfg = JSON.parse(cfg27);
argvCfg.codex.run = [...runOf('codex'), '{prompt}'];
fs.writeFileSync(path.join(HOME, 'scribes.json'), JSON.stringify(argvCfg, null, 2), 'utf8');
plantAs('c1', 'claude', { quotes: '不是数组' });
plantAs('c2', 'claude', { text: '超长'.repeat(20000) });
plantAs('c3', 'claude');
plantAs('c4', 'claude');
fs.writeFileSync(MODE, 'crash', 'utf8');
resetCalls();
const r27c = runReview();
fs.writeFileSync(path.join(HOME, 'scribes.json'), cfg27, 'utf8');
const n27c = whoCalled('codex');
const c27 = n27c === 2 && jsons().length === 4 && /拼不出审核提示/.test(r27c.stderr) && /PROMPT_TOO_LONG|送不出去/.test(r27c.stderr);
const c27left = jsons().length;
// (d) 失败和成功交替：连续计数总被清零，但失败累计耗时到预算（2 × 单次超时）也要熔断（第十八轮 C）。
// 超时调成 1.5 秒；codex 第 1、3… 次卡住被杀，第 2 次正常 → 第 3 次失败时累计 ≥ 3 秒，后面三条不再叫。
fs.rmSync(PEND, { recursive: true, force: true });
for (const n of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']) plantAs(n, 'claude');
fs.writeFileSync(MODE, 'hang-odd-codex', 'utf8');
resetCalls();
const r27d = runReview({ AGENTMEM_MODEL_TIMEOUT_MS: '1500' });
const n27d = whoCalled('codex');
const d27 = n27d === 3 && /失败累计 \d+ 秒，本轮不再叫它/.test(r27d.stderr) && /跳过 3 条/.test(r27d.stdout);
// (e) 进程起不来、运行时才报 ENAMETOOLONG（不是预检拦下的）：同样只扣下那一条，不算审核者挂了
fs.rmSync(PEND, { recursive: true, force: true });
for (const n of ['e1', 'e2', 'e3']) plantAs(n, 'claude');
fs.writeFileSync(MODE, 'accept', 'utf8');
resetCalls();
const r27e = runReview({ AGENTMEM_FAULT: 'model-enametoolong' });
const e27 = jsons().length === 3 && (r27e.stderr.match(/送不出去/g) || []).length === 3 && !/不可用/.test(`${r27e.stdout}${r27e.stderr}`);
// (f) 配置里直接写 cmd.exe /c x.cmd：载体是 cmd，上限 8191 —— 8200 字的提示要在启动前拦下，不能交给 cmd 报「命令行太长」
// 再被当成审核者挂了（第十八轮 C）
fs.rmSync(PEND, { recursive: true, force: true });
const STUB_CMD = path.join(HOME, 'stub.cmd');
fs.writeFileSync(STUB_CMD, `@node "${STUB}" %*\r\n`, 'utf8');
const cmdCfg = JSON.parse(cfg27);
cmdCfg.codex.run = ['cmd.exe', '/c', STUB_CMD, 'codex', ...cmdCfg.codex.run.slice(3), '{prompt}'];
fs.writeFileSync(path.join(HOME, 'scribes.json'), JSON.stringify(cmdCfg, null, 2), 'utf8');
plantAs('f1', 'claude', { text: 'a'.repeat(8200) });
resetCalls();
const r27f = runReview();
fs.writeFileSync(path.join(HOME, 'scribes.json'), cfg27, 'utf8');
const f27 = whoCalled('codex') === 0 && /PROMPT_TOO_LONG/.test(r27f.stderr) && !/不可用/.test(r27f.stderr);
// (g) 一轮的时间预算用完：不再开始新的调用，剩下的原地留着，总结行说出来
fs.rmSync(PEND, { recursive: true, force: true });
for (const n of ['g1', 'g2']) plantAs(n, 'claude');
resetCalls();
const r27g = runReview({ AGENTMEM_REVIEW_BUDGET_MS: '0' });
const g27 = calls().length === 0 && jsons().length === 2 && /本轮到时间了，2 条没开始审/.test(r27g.stdout);
fs.writeFileSync(MODE, 'accept', 'utf8');
ok('27b 熔断：连续失败两次 / 失败累计超时才熔断、只熔断那一个审核者；成功一次清零；坏候选只扣下自己；整轮有时间预算',
  a27 && b27 && c27 && d27 && e27 && f27 && g27,
  `(a) codex 叫 ${n27a[0]} 次（应为 2）、claude 叫 ${n27a[1]} 次（应为 1）、${r27a.stdout.match(/跳过 \d+ 条/)?.[0] || '没报跳过'}；`
  + `(b) codex 叫 ${n27b} 次（应为 4）：${r27b.stdout.trim().split('\n').pop().slice(0, 60)}；`
  + `(c) codex 叫 ${n27c} 次（应为 2）、候选剩 ${c27left}（应为 4）=${c27}；`
  + `(d) 交替超时：codex 叫 ${n27d} 次（应为 3）=${d27}；(e) 运行时 ENAMETOOLONG 不计数=${e27}；`
  + `(f) cmd.exe 载体按 8191 拦=${f27}；(g) 时间预算=${g27}；`
  + `stderr(c)：${r27c.stderr.replace(/\s+/g, ' ').slice(0, 120)}`);
fs.rmSync(PEND, { recursive: true, force: true });

// ---- 28. scribe 中途被杀（停在第二段的模型调用里），重跑既不重复产出、也不重跑已做完的那段
// 两件事分开断言，因为它们靠的是两样不同的东西：
//   · 不重复 —— 靠三步发布 + 开头对账（第 29、29b 条专测）；
//   · 不重跑已做完的第一段 —— 靠发布时先存水位。只断言「不重复」的话，这条测不到它，所以数重跑的模型调用。
// 先清掉 log 和索引：桩的正文是同一个模板，库里积多了会把新候选当成「已记过」，那样这一条就测不到东西了。
// 两段的主题也必须真的不同：pending 里的候选同样参与去重，只差一个字的两段实测余弦 0.979，会被当成同一件事。
fs.rmSync(path.join(HOME, 'log'), { recursive: true, force: true });
fs.rmSync(path.join(HOME, 'index.sqlite'), { force: true });
fs.rmSync(PEND, { recursive: true, force: true });
fs.writeFileSync(MODE, 'gate', 'utf8');
gate.reset(); gate.hold(2);
fs.appendFileSync(CT_FILE, claudeTurn('被杀之后重跑甲：sqlite 的 WAL 模式要在建库时打开', ['Edit']), 'utf8');
fs.appendFileSync(CT_FILE2, claudeTurn('被杀之后重跑乙：Windows 命名管道锁随进程退出释放', ['Write']), 'utf8');
const S28 = spawn(process.execPath, [CLI, 'scribe'], { env: autoEnv, cwd: REPO, stdio: 'ignore' });
const in28 = await waitFor(() => gate.entered(2), 60000);
const first28 = jsons().length;
S28.kill();
await exited(S28);
gate.open(2);
fs.writeFileSync(MODE, 'accept', 'utf8');
resetCalls();
memo(['scribe']);
const rerunCalls28 = calls().length;
const titles28 = jsons().map((f) => { try { return JSON.parse(fs.readFileSync(path.join(PEND, f), 'utf8')).title; } catch { return ''; } });
const dupe28 = titles28.length !== new Set(titles28).size;
ok('28 scribe 停在模型调用里被杀，重跑不重复、不重做', in28 && first28 === 1 && titles28.length === 2 && !dupe28 && rerunCalls28 === 1,
  `被杀前已产出 ${first28} 条（应为 1）；重跑后共 ${titles28.length} 条（应为 2），有重复=${dupe28}；`
  + `重跑调模型 ${rerunCalls28} 次（应为 1：只做没做完的那段）`);

// ---- 29. 发布候选的三步之间被杀（一）：「写好 .tmp、还没存水位」
// 发布顺序见 lib/scribe.mjs：写 .tmp → 存水位 → 改名。水位没存，这个窗口下次会重做，
// 所以留下的 .tmp 必须作废 —— 不作废就是重做出来的那条和它重复。
fs.rmSync(PEND, { recursive: true, force: true });
fs.writeFileSync(MODE, 'accept', 'utf8');
const scribeWithFault = (fp) => {
  try {
    execFileSync(process.execPath, [CLI, 'scribe'], {
      env: { ...autoEnv, AGENTMEM_FAILPOINT: fp }, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 0;
  } catch (e) { return e.status; }
};
const tmps = () => { try { return fs.readdirSync(PEND).filter((f) => f.endsWith('.json.tmp')).length; } catch { return 0; } };
const titlesNow = () => jsons().map((f) => { try { return JSON.parse(fs.readFileSync(path.join(PEND, f), 'utf8')).title; } catch { return ''; } });
fs.appendFileSync(CT_FILE, claudeTurn('写好临时文件还没存水位就被杀', ['Edit']), 'utf8');
const code29 = scribeWithFault('scribe-after-stage');
const staged29 = tmps();
resetCalls();
memo(['scribe']);
ok('29 写好 .tmp、没存水位就被杀：作废它，重做出一条',
  code29 === 86 && staged29 === 1 && calls().length === 1 && jsons().length === 1 && tmps() === 0,
  `注入点退出码 ${code29}；被杀后留下 .tmp ${staged29} 个；重跑调模型 ${calls().length} 次（应为 1：水位没存得重做）；`
  + `之后 pending ${jsons().length} 条（应为 1），残留 .tmp ${tmps()} 个（应为 0）`);

// ---- 29b. 发布候选的三步之间被杀（二）：「存好水位、还没改名」，而且重跑之前会话又变长了
// 水位已经越过这个窗口，它不会再被处理 —— 留下的 .tmp 必须补发布，不然这段内容就丢了。
// 这正是 Codex 第四轮复核指出的丢失路径：上一版用「文件 + 窗口起点」当 id，会话变长后重跑出来的候选
// 和已进库的那条同 id，被当成「已进库」删掉，多出来的那段永久丢失。
fs.rmSync(PEND, { recursive: true, force: true });
fs.appendFileSync(CT_FILE, claudeTurn('存好水位还没发布就被杀甲', ['Edit']), 'utf8');
const code29b = scribeWithFault('scribe-after-mark');
const staged29b = tmps();
fs.appendFileSync(CT_FILE, claudeTurn('之后会话又多了一段乙', ['Write']), 'utf8');   // 重跑之前会话变长
resetCalls();
const out29b = memo(['scribe']);
const t29b = titlesNow();
const hasA = t29b.some((t) => t.includes('存好水位还没发布就被杀甲'));
const hasB = t29b.some((t) => t.includes('之后会话又多了一段乙'));
ok('29b 存好水位没发布就被杀、会话又变长：旧的补发布，新的另起一条',
  code29b === 86 && staged29b === 1 && /补发布/.test(out29b) && t29b.length === 2 && hasA && hasB && calls().length === 1 && tmps() === 0,
  `注入点退出码 ${code29b}；留下 .tmp ${staged29b} 个；补发布=${/补发布/.test(out29b)}；`
  + `pending ${t29b.length} 条（应为 2），旧的在=${hasA}、新的在=${hasB}；重跑调模型 ${calls().length} 次（应为 1：只做新增的那段）`);

// ---- 29c–29f. 读失败时整轮不跑：不删、不发布、不推进水位、不叫模型
// Codex 第五轮复核注入复现的四条路径，原来都把读错误吞掉了：
//   29c 对账读不了某个 .tmp → 当坏文件删掉 → 它的水位其实存过 → 窗口永久丢失
//   29d 读不了水位表 → 当成空表 → 对账把已提交的候选当未提交删掉
//   29e 对账列不出目录 → 跳过对账接着推进水位 → 旧 .tmp 以后被补发布 → 和重做的那条重复
//   29f --init 读不了会话 → 水位记成 0 → 从头重扫 → 重复
// 「对正常文件读出 EIO」在 Windows 上造不出来，用读失败注入点 AGENTMEM_FAULT。
// 每条最后都去掉注入再跑一次，确认什么都没丢、也没多。
const scribeWithReadFault = (fault, extra = []) => spawnSync(process.execPath, [CLI, 'scribe', ...extra], {
  env: { ...autoEnv, AGENTMEM_FAULT: fault }, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
});
const markBytes = () => { try { return fs.readFileSync(path.join(HOME, 'scribemark.json'), 'utf8'); } catch { return ''; } };
// 造一个「水位已存、还没改名」的 .tmp（29b 的那种状态），再追加一段新会话，让继续往下跑的 scribe 会叫模型。
const stageCommitted = (tag) => {
  fs.rmSync(PEND, { recursive: true, force: true });
  fs.writeFileSync(MODE, 'accept', 'utf8');
  fs.appendFileSync(CT_FILE, claudeTurn(`已提交的暂存${tag}：tsx 跑 ESM 要用 --import 而不是 --loader`, ['Edit']), 'utf8');
  scribeWithFault('scribe-after-mark');
  fs.appendFileSync(CT_FILE, claudeTurn(`之后的新内容${tag}：防火墙规则枚举是 O(n) 的，批量加要一次性`, ['Write']), 'utf8');
};
const aborted = (r, before) => r.status !== 0 && calls().length === 0 && markBytes() === before && tmps() === 1 && jsons().length === 0;

for (const [n, fault, what] of [['29c', 'reconcile-read', '对账读不了 .tmp'], ['29d', 'mark', '读不了水位表']]) {
  stageCommitted(n);
  const before = markBytes();
  resetCalls();
  const r = scribeWithReadFault(fault);
  const stopped = aborted(r, before);
  resetCalls();
  memo(['scribe']);                                 // 去掉注入：旧的补发布、新的另起一条，各一条
  const t = titlesNow();
  ok(`${n} ${what}：整轮不跑，修好后一条不丢`, stopped && t.length === 2
    && t.some((x) => x.includes(`已提交的暂存${n}`)) && t.some((x) => x.includes(`之后的新内容${n}`)),
    `注入后退出码 ${r.status}（应非 0）、调模型 0 次、水位没动、.tmp 还在、没发布=${stopped}；`
    + `去掉注入后 pending ${t.length} 条（应为 2：旧的补发布 + 新的）`);
}

// 29e 要的是「水位没存」的 .tmp：吞掉列目录错误时，这一轮会重做并推进水位，旧 .tmp 以后被补发布成重复。
fs.rmSync(PEND, { recursive: true, force: true });
fs.appendFileSync(CT_FILE, claudeTurn('列不出目录时不能接着推进水位', ['Edit']), 'utf8');
scribeWithFault('scribe-after-stage');
const before29e = markBytes();
resetCalls();
const r29e = scribeWithReadFault('reconcile-list');
const stopped29e = r29e.status !== 0 && calls().length === 0 && markBytes() === before29e;
memo(['scribe']);
memo(['scribe']);                                   // 再跑一次：吞错误的旧逻辑会在这一轮把旧 .tmp 补发布出来
const t29e = titlesNow().filter((x) => x.includes('列不出目录时不能接着推进水位'));
ok('29e 对账列不出目录：整轮不跑，之后也不重复', stopped29e && t29e.length === 1 && tmps() === 0,
  `注入后退出码 ${r29e.status}、调模型 ${calls().length} 次、水位没动=${markBytes() === before29e || '(之后已正常推进)'}；`
  + `去掉注入跑两次后这段内容的候选 ${t29e.length} 条（应为 1），残留 .tmp ${tmps()} 个`);

// 29f：--init 读不了会话 → 一个水位都不写就退出
const before29f = markBytes();
const r29f = scribeWithReadFault('init-read', ['--init']);
ok('29f --init 读不了会话：不写水位、直接退出', r29f.status !== 0 && markBytes() === before29f,
  `退出码 ${r29f.status}（应非 0）；水位表一个字节没动=${markBytes() === before29f}`);

// ---- 29g. dsh 的会话读不了时，--init 也必须退出 —— 不能被读取器内部吞掉、照样把水位记成 0
// Codex 第六轮复核发现：第 29f 修的是外层，可 dsh 的读取器自己把读错误、解析错误都吞掉、返回空数组，
// 外层收不到异常，水位还是 0。另起一个只有 claude + dsh 的临时库，免得改动主测试库的审核环。
const HOME_G = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmem-dshinit-'));
const DSH_DIR = path.join(HOME_G, 'dsh');
fs.mkdirSync(DSH_DIR, { recursive: true });
fs.writeFileSync(path.join(DSH_DIR, 'session-broken.json'), '{"record": {"rows": ', 'utf8');   // dsh 正重写到一半
fs.writeFileSync(path.join(HOME_G, 'scribes.json'), JSON.stringify({
  claude: { model: 'stub', format: 'claude', transcripts: [path.join(HOME_G, 'none', '*.jsonl')], run: runOf('claude') },
  dsh: { model: 'stub', format: 'dsh', transcripts: [path.join(DSH_DIR, '*.json')], run: ['node', STUB, 'dsh'] },
}, null, 2), 'utf8');
const r29g = spawnSync(process.execPath, [CLI, 'scribe', '--init'], {
  env: { ...autoEnv, AGENTMEM_HOME: HOME_G }, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
});
const markWritten29g = fs.existsSync(path.join(HOME_G, 'scribemark.json'));
ok('29g dsh 会话读不了：--init 退出、不写水位', r29g.status !== 0 && !markWritten29g,
  `退出码 ${r29g.status}（应非 0）；写了水位表=${markWritten29g}（应为 false）`);
fs.rmSync(HOME_G, { recursive: true, force: true });

// ---- 29h. claude 正往会话里写最后一行时被扫到：半截行不能算进水位，写完之后要**真的被读到**
// 和 log 索引那边（core 第 10 条）是同一个缺陷：原来连半截行一起数，水位越过它，写完也再不会读到它。
// 只比水位数字不够（Codex 第七轮复核：把新内容整个吞掉、照样推进水位，原版这条仍是绿的），
// 所以助手那行里放一个独有的记号，断言写完之后模型真的收到了它。
const markOf = (file) => {
  const m = JSON.parse(fs.readFileSync(path.join(HOME, 'scribemark.json'), 'utf8'));
  const k = Object.keys(m).find((x) => path.resolve(x) === path.resolve(file));
  return k === undefined ? null : m[k];
};
const fullLines = (file) => fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).filter((l) => l.trim()).length;
fs.writeFileSync(MODE, 'accept', 'utf8');
const MARK_29H = '记号二九h：这一行写完之后必须被读到';
const userLine = JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), cwd: 'C:\\x', message: { role: 'user', content: '最后一行还没写完就被扫到' } });
const assistantLine = JSON.stringify({
  type: 'assistant', timestamp: new Date().toISOString(),
  message: { role: 'assistant', content: [{ type: 'text', text: `${MARK_29H}。${FILLER}` }, { type: 'tool_use', name: 'Edit', input: {} }] },
});
fs.appendFileSync(CT_FILE, `${userLine}\n${assistantLine.slice(0, 80)}`, 'utf8');   // 助手那行只写了一半
memo(['scribe']);
const whileHalf = markOf(CT_FILE);
const expectHalf = fullLines(CT_FILE);
fs.appendFileSync(CT_FILE, `${assistantLine.slice(80)}\n`, 'utf8');                 // 写完
resetCalls();
fs.rmSync(path.join(HOME, 'last-scribe.txt'), { force: true });
memo(['scribe']);
const afterDone = markOf(CT_FILE);
let seen29h = false;
try { seen29h = fs.readFileSync(path.join(HOME, 'last-scribe.txt'), 'utf8').includes(MARK_29H); } catch { /* 模型没被叫到 */ }
ok('29h 会话最后一行没写完：不算进水位，写完后模型真的读到它',
  whileHalf === expectHalf && afterDone === expectHalf + 1 && calls().length === 1 && seen29h,
  `写到一半时水位 ${whileHalf}（应为 ${expectHalf}：不含半截行）；写完后水位 ${afterDone}（应为 ${expectHalf + 1}）；`
  + `写完后调模型 ${calls().length} 次（应为 1），模型收到了那一行的内容=${seen29h}`);

// ---- 29i. .tmp 写完之后被损坏（解析不了）：不知道水位存没存，就不能删
// Codex 第七轮复核：上一版认定「解析不了 = 写到一半 = 水位一定没存」并删掉它；可它也可能是写完、
// 存完水位之后才被截断或误改 —— 删掉，这个窗口就永久漏了（注入复现）。现在原样挪成 .corrupt。
fs.rmSync(PEND, { recursive: true, force: true });
fs.appendFileSync(CT_FILE, claudeTurn('写完之后才被损坏的暂存', ['Edit']), 'utf8');
scribeWithFault('scribe-after-mark');                    // 水位已存、.tmp 完整
const tmpName29i = fs.readdirSync(PEND).find((f) => f.endsWith('.json.tmp'));
const tmpPath29i = path.join(PEND, tmpName29i || 'missing');
const damaged = fs.readFileSync(tmpPath29i, 'utf8').slice(0, -2);   // 截掉最后两个字节
fs.writeFileSync(tmpPath29i, damaged, 'utf8');
memo(['scribe']);
const kept29i = fs.existsSync(`${tmpPath29i}.corrupt`) && fs.readFileSync(`${tmpPath29i}.corrupt`, 'utf8') === damaged;
const pend29i = memo(['pending']);
ok('29i 写完后被损坏的 .tmp 原样留着，不删', !!tmpName29i && kept29i && !fs.existsSync(tmpPath29i) && pend29i.includes('坏文件'),
  `原样挪成 .corrupt=${kept29i}；memo pending 列出=${pend29i.includes('坏文件')}`);
fs.rmSync(PEND, { recursive: true, force: true });

// ---- 29j. .tmp 能解析、但提交元数据无效：判断不了，就不删
// Codex 第八轮复核：29i 只堵了「解析不了」，「能解析但元数据无效」那条路上一版还是当成未提交删掉。
// 第九轮复核：原版这条只放了「两个字段同时缺」一种，把校验从「或」改成「且」照样通过；空 sourceFile 也漏了。
// 所以每种无效**各放一个**，每一个都必须原样留成 .corrupt。最后一种元数据有效、但源会话不在扫描范围里：
// 那个窗口再也不会被重做，删了就是丢。
// window 用 [0, 1]：CT_FILE 的水位早就越过 1 了，哪一种校验被拿掉，那个 .tmp 就会被**补发布**，测得出来。
fs.mkdirSync(PEND, { recursive: true });
// agent 必须是配置里有的：作者认不出来的暂存会被另一条规则隔离（下面最后一种），那样前面几种就测不到各自的校验了
const good29j = { id: 'meta', agent: 'claude', title: '元数据无效的暂存', text: '能解析', sourceFile: CT_FILE, window: [0, 1] };
const variants29j = [
  ['缺 sourceFile', { ...good29j, sourceFile: undefined }],
  ['缺 window', { ...good29j, window: undefined }],
  ['window 键名写错', (() => { const { window: w, ...rest } = good29j; return { ...rest, windoW: w }; })()],
  ['window 终点不是整数', { ...good29j, window: [0, 1.5] }],
  ['window 起点不是整数', { ...good29j, window: [0.5, 1] }],
  ['window 起点不小于终点', { ...good29j, window: [1, 1] }],
  ['sourceFile 是空串', { ...good29j, sourceFile: '' }],
  ['源会话不在扫描范围里', { ...good29j, sourceFile: path.join(HOME, 'gone', 'deleted.jsonl'), window: [0, 999999] }],
  // Codex 第十二轮复核：从配置里删掉 dsh 后，它留下的旧暂存绕过了坐标核对、被补发布
  ['作者不在配置里', { ...good29j, agent: 'removed-agent' }],
].map(([what, obj]) => {
  const p = path.join(PEND, `${crypto.randomUUID()}.json.tmp`);
  const body = JSON.stringify(obj);
  fs.writeFileSync(p, body, 'utf8');
  return { what, p, body };
});
memo(['scribe']);
const bad29j = variants29j.filter(({ p, body }) => !(fs.existsSync(`${p}.corrupt`)
  && fs.readFileSync(`${p}.corrupt`, 'utf8') === body && !fs.existsSync(p) && !fs.existsSync(p.slice(0, -'.tmp'.length))));
// memo pending 要把这种「内容完整、判断不了提交没提交」的叫「隔离」，不能叫「读不出来的坏文件」（Codex 第十三轮复核：会误导恢复）
const pend29j = memo(['pending']);
// 每一件都要单独列出、标成隔离（Codex 第十四轮复核：原来只查「有一行隔离」，只显示第一件也通过）
const labeled29j = variants29j.every(({ p }) => pend29j.split('\n').some((l) => l.startsWith('隔离') && l.includes(`${path.basename(p)}.corrupt`)))
  && !/坏文件 [^\n]*（读不出来/.test(pend29j);
ok('29j 元数据无效的 .tmp（九种各一个）全部原样留着，不删也不发布；memo pending 标成「隔离」', bad29j.length === 0 && jsons().length === 0 && labeled29j,
  `没被原样隔离的：${bad29j.map((v) => v.what).join('、') || '无'}；被发布出来的 ${jsons().length} 条（应为 0）；`
  + `memo pending 标成隔离、没叫成读不出来的坏文件=${labeled29j}`);
fs.rmSync(PEND, { recursive: true, force: true });

// ---- 29k. 积压超过一次能喂的上限：每一行都要进且只进一段，每段不超过上限
// Codex 第七、八轮复核：原来只取窗口尾部 24000 字，水位却越过整个窗口 —— 长时间断线攒下的积压，
// 前面那部分从来没被看过就被标成看完了。
// 第九轮复核：原版只验首尾两个记号，把中间几行从模型输入里删掉照样通过。现在**每一行**放一个独有记号，
// 断言每个记号恰好出现在一段里（不漏、不重叠），且每段正文都不超过上限。
fs.writeFileSync(MODE, 'accept', 'utf8');
const bigText = FILLER.repeat(26);                       // 每行约 4900 字
const mark29k = (n) => `〔二九k-${n}〕`;
const backlog = [
  JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), cwd: 'C:\\x', message: { role: 'user', content: `${mark29k(0)}积压最前面的这段也必须被模型看到` } }),
  ...[1, 2, 3, 4, 5].map((n) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: `${mark29k(n)}第${n}段。${bigText}` }] } })),
  JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: `${mark29k(6)}积压最后面的这段。${FILLER}` }, { type: 'tool_use', name: 'Edit', input: {} }] } }),
];
fs.appendFileSync(CT_FILE, `${backlog.join('\n')}\n`, 'utf8');
fs.rmSync(path.join(HOME, 'all-scribe.txt'), { force: true });
resetCalls();
memo(['scribe']);
// 每次 scribe 调用的输入（桩追加留底，见 stub 里的 all-scribe.txt），只取【会话片段】之后的正文
const fedPrompts = () => {
  let all = '';
  try { all = fs.readFileSync(path.join(HOME, 'all-scribe.txt'), 'utf8'); } catch { return []; }
  return all.split('\n=====\n').filter((x) => x.includes('【会话片段】')).map((x) => x.split('【会话片段】\n')[1] || '');
};
const fed29k = fedPrompts();
// 数的是**出现次数**：只数「包含它的段数」的话，同一段里一行出现两次照样是 1（Codex 第十轮复核）
const spread29k = [0, 1, 2, 3, 4, 5, 6].map((n) => fed29k.reduce((c, x) => c + x.split(mark29k(n)).length - 1, 0));
const maxLen29k = Math.max(0, ...fed29k.map((x) => x.length));
const atEnd29k = markOf(CT_FILE) === fullLines(CT_FILE);
ok('29k 积压超过上限：每一行恰好进一段，每段不超过上限', spread29k.every((c) => c === 1) && fed29k.length >= 2 && maxLen29k <= 24000 && atEnd29k,
  `7 行各自在模型输入里出现几次：${spread29k.join(',')}（都应为 1）；分了 ${fed29k.length} 段（应 ≥2），最长一段 ${maxLen29k} 字（应 ≤24000）；`
  + `水位推到会话末尾=${atEnd29k}`);
fs.rmSync(PEND, { recursive: true, force: true });

// 下面几条都要「会切成几段」的积压。段边界会优先落在一轮用户提问的开头（前提是这一段已经过半），
// 所以每轮都是「一句提问 + 两三行长回答」，段数和边界都算得出来。
// 每轮的提问是互不相干的主题：pending 里的候选也参与去重，桩的正文是同一个模板，主题相近就会被当成同一件事。
const userL = (text) => JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), cwd: 'C:\\x', message: { role: 'user', content: text } });
const asstL = (text, tools = []) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
  message: { role: 'assistant', content: [{ type: 'text', text }, ...tools.map((name) => ({ type: 'tool_use', name, input: {} }))] } });
const appendLines = (file, lines) => fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
const markFile = () => JSON.parse(fs.readFileSync(path.join(HOME, 'scribemark.json'), 'utf8'));
const contOf = (file) => {
  const c = markFile()['#continue'] || {};
  const k = Object.keys(c).find((x) => path.resolve(x) === path.resolve(file));
  return k === undefined ? null : c[k];
};
const pendingCands = () => jsons().map((f) => JSON.parse(fs.readFileSync(path.join(PEND, f), 'utf8')));

// ---- 29l. 分段之后第二段调用失败：水位只退回到第二段的起点，第一段的候选原样保住、下次不重做
// 退回到整个窗口的起点也「不丢」，但第一段要重跑一遍模型、可能再产一条重复的候选。
// 第九轮复核：原版只验水位数字，把第一段已发布的候选删掉照样通过。现在断言候选本身（id 和标题）。
const before29l = markOf(CT_FILE);
appendLines(CT_FILE, [
  userL('分段甲：pnpm 的 store 换盘之后要重新 link'),
  ...[1, 2, 3].map((n) => asstL(`甲${n}。${bigText}`, ['Edit'])),
  userL('分段乙：PowerShell 5.1 的 Set-Content 默认是 ANSI 编码'),
  ...[1, 2, 3].map((n) => asstL(`乙${n}。${bigText}`, ['Edit'])),
]);
fs.writeFileSync(MODE, 'crash-after-1', 'utf8');
resetCalls();
memo(['scribe']);
const mid29l = markOf(CT_FILE);
const firstCands = pendingCands();
fs.writeFileSync(MODE, 'accept', 'utf8');
resetCalls();
memo(['scribe']);
const rerun29l = calls().length;
const after29l = pendingCands();
const kept29l = firstCands.length === 1 && firstCands[0].title.includes('分段甲')
  && after29l.some((c) => c.id === firstCands[0].id && c.title === firstCands[0].title);
ok('29l 第二段失败：水位停在第二段起点，第一段的候选原样保住，下次只做第二段',
  mid29l === before29l + 4 && kept29l && rerun29l === 1 && after29l.length === 2 && after29l.some((c) => c.title.includes('分段乙'))
  && markOf(CT_FILE) === fullLines(CT_FILE) && contOf(CT_FILE) === null,
  `失败后水位 ${mid29l}（应为 ${before29l + 4}：第一段的 4 行）；失败后候选 ${firstCands.length} 条且是第一段的=${kept29l}；`
  + `恢复后重跑调模型 ${rerun29l} 次（应为 1），候选共 ${after29l.length} 条（应为 2）；`
  + `最终水位到末尾=${markOf(CT_FILE) === fullLines(CT_FILE)}，续做标记已清=${contOf(CT_FILE) === null}`);
fs.rmSync(PEND, { recursive: true, force: true });

// ---- 29m. 失败后剩下的那段「自己看没动过东西」：仍然要接着做，不能被重新预筛掉
// Codex 第九轮复核（严重）：唯一的写操作在已经做完的第一段里，第二段失败后水位退回第二段起点；
// 下一轮把剩下的后缀当成新窗口重新预筛 → 「没动过东西」→ 直接越过，第二段从来没送进模型。
// 修法是「续做」标记：已经过了预筛的窗口，下一轮从水位接着做，不再预筛（见 lib/scribe.mjs 的 CONT）。
const B4_MARK = '〔二九m：只读的第二段也必须被看到〕';
appendLines(CT_FILE, [
  userL('续做甲：git worktree 删不掉是因为 node 还拿着文件句柄'),
  ...[1, 2, 3].map((n) => asstL(`甲${n}。${bigText}`, n === 3 ? ['Edit'] : [])),
  userL(`续做乙：${B4_MARK}`),
  ...[1, 2, 3].map((n) => asstL(`乙${n}。${bigText}`)),       // 第二段没有任何写操作
]);
fs.writeFileSync(MODE, 'crash-after-1', 'utf8');
resetCalls();
memo(['scribe']);
const mid29m = contOf(CT_FILE);
fs.writeFileSync(MODE, 'accept', 'utf8');
resetCalls();
fs.rmSync(path.join(HOME, 'last-scribe.txt'), { force: true });
memo(['scribe']);
let seen29m = false;
try { seen29m = fs.readFileSync(path.join(HOME, 'last-scribe.txt'), 'utf8').includes(B4_MARK); } catch { /* 没叫模型 */ }
ok('29m 失败后剩下的只读段：接着做，不被重新预筛掉', mid29m === fullLines(CT_FILE) && calls().length === 1 && seen29m
  && markOf(CT_FILE) === fullLines(CT_FILE) && contOf(CT_FILE) === null,
  `失败后续做标记=${mid29m}（应为窗口终点 ${fullLines(CT_FILE)}）；恢复后调模型 ${calls().length} 次（应为 1，旧逻辑是 0）；`
  + `第二段进了模型=${seen29m}；最终水位到末尾、续做标记已清=${markOf(CT_FILE) === fullLines(CT_FILE) && contOf(CT_FILE) === null}`);
fs.rmSync(PEND, { recursive: true, force: true });

// ---- 29n. 失败后剩下的那段不足 200 字：同样要接着做
// 第九轮复核：预筛还有「太短」这一条，失败后剩下一小截时同样会被越过。
const SHORT_MARK = '〔二九n：短尾〕';
const head29n = userL('短尾甲：Windows 上 detached 的子进程没有控制台');
const lenOfUnit = (t) => t.length;
// 让「提问 + 长回答」正好凑到 23990 字左右，后面那句短提问就装不下、自成一段
const fillLen = 23990 - lenOfUnit('用户：短尾甲：Windows 上 detached 的子进程没有控制台') - 1 - lenOfUnit('助手：\n〔工具 Edit〕');
appendLines(CT_FILE, [head29n, asstL('长'.repeat(fillLen), ['Edit']), userL(`短尾乙：${SHORT_MARK}`)]);
fs.writeFileSync(MODE, 'crash-after-1', 'utf8');
resetCalls();
memo(['scribe']);
const calls29nFirst = calls().length;
fs.writeFileSync(MODE, 'accept', 'utf8');
resetCalls();
fs.rmSync(path.join(HOME, 'last-scribe.txt'), { force: true });
memo(['scribe']);
let seen29n = false;
try { seen29n = fs.readFileSync(path.join(HOME, 'last-scribe.txt'), 'utf8').includes(SHORT_MARK); } catch { /* 没叫模型 */ }
ok('29n 失败后剩下不足 200 字：同样接着做', calls29nFirst === 2 && calls().length === 1 && seen29n && markOf(CT_FILE) === fullLines(CT_FILE),
  `第一次调模型 ${calls29nFirst} 次（应为 2：分了两段、第二段失败）；恢复后调模型 ${calls().length} 次（应为 1，旧逻辑是 0）；短尾进了模型=${seen29n}`);
fs.rmSync(PEND, { recursive: true, force: true });

// ---- 29o. 没有候选的段也要马上存水位：中途被杀，已经判完的段不重问
// 第九轮复核：原来只有发布候选时才存水位，「不值得记」的段只改内存、整轮结束才存 ——
// 前三段判完后被杀，落盘水位还是 0，恢复后全部重问（再赶上 auto 30 分钟到点杀进程，就是反复付费不推进）。
// 用注入点在「第一段判完、存好水位」之后退出。
const before29o = markOf(CT_FILE);
appendLines(CT_FILE, [
  userL('存档甲：每段判完都要落盘'), asstL(`甲。${FILLER.repeat(70)}`, ['Edit']),
  userL('存档乙：被杀之后不重问'), asstL(`乙。${FILLER.repeat(70)}`),
  userL('存档丙：只做剩下的'), asstL(`丙。${FILLER.repeat(70)}`),
]);
fs.writeFileSync(MODE, 'worthless', 'utf8');
resetCalls();
const code29o = scribeWithFault('scribe-after-checkpoint');
const mid29o = markOf(CT_FILE);
resetCalls();
memo(['scribe']);
ok('29o 「不值得记」的段也马上存水位：被杀后不重问已判完的段',
  code29o === 86 && mid29o === before29o + 2 && calls().length === 2 && markOf(CT_FILE) === fullLines(CT_FILE),
  `注入点退出码 ${code29o}（应为 86）；被杀时落盘水位 ${mid29o}（应为 ${before29o + 2}：第一段的 2 行）；`
  + `恢复后调模型 ${calls().length} 次（应为 2：只问剩下两段）`);

// ---- 29p. 每家一轮最多叫几次模型：到了就停，剩下的下一轮接着做（不重新预筛）
// 第九轮复核：没有任何预算，几十万字的积压一轮就要叫几十次模型。上限按家算（各家额度是分开的池）。
appendLines(CT_FILE, [
  userL('预算甲：到上限就停'), asstL(`甲。${FILLER.repeat(70)}`, ['Edit']),
  userL('预算乙：停在段的起点'), asstL(`乙。${FILLER.repeat(70)}`),
  userL('预算丙：下一轮接着做'), asstL(`丙。${FILLER.repeat(70)}`),
]);
fs.writeFileSync(MODE, 'worthless', 'utf8');
resetCalls();
const before29p = markOf(CT_FILE);
const capped = (n) => spawnSync(process.execPath, [CLI, 'scribe'], {
  env: { ...autoEnv, AGENTMEM_SCRIBE_MAX_CALLS: String(n) }, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
});
const r29p = capped(2);
const calls29pFirst = calls().length;
const mid29p = markOf(CT_FILE);
const cont29p = contOf(CT_FILE);
resetCalls();
memo(['scribe']);
const calls29pSecond = calls().length;
// 重问也算调用（Codex 第十轮复核：上一版只在段开头查上限，重问那次不查，上限 20 实际可能 21）。
// fabricate 模式每段都要重问一次：上限 3 时第一段 2 次、第二段第 1 次，第二段的重问必须被拦下。
appendLines(CT_FILE, [
  userL('重问预算甲：引证编造'), asstL(`甲。${FILLER.repeat(70)}`, ['Edit']),
  userL('重问预算乙：重问也要算数'), asstL(`乙。${FILLER.repeat(70)}`),
]);
const before29p2 = markOf(CT_FILE);
fs.writeFileSync(MODE, 'fabricate', 'utf8');
resetCalls();
const r29p2 = capped(3);
const calls29pRetry = calls().length;
const mid29p2 = markOf(CT_FILE);
fs.writeFileSync(MODE, 'worthless', 'utf8');
memo(['scribe']);                                   // 把剩下的做完，别留给后面的测试
ok('29p 到了调用上限（重问也算）：停在段的起点，下一轮只做剩下的', r29p.status === 0 && /调用上限/.test(r29p.stdout) && calls29pFirst === 2
  && mid29p === before29p + 4 && cont29p === before29p + 6 && calls29pSecond === 1
  && /调用上限/.test(r29p2.stdout) && calls29pRetry === 3 && mid29p2 === before29p2 + 2,
  `上限 2：调模型 ${calls29pFirst} 次、报出上限=${/调用上限/.test(r29p.stdout)}、水位 ${mid29p}（应为 ${before29p + 4}）、`
  + `续做标记=${cont29p}（应为 ${before29p + 6}）；下一轮调模型 ${calls29pSecond} 次（应为 1：第三段没有写操作也照做）；`
  + `每段都重问时上限 3：调模型 ${calls29pRetry} 次（应为 3，旧逻辑 4）、水位停在第二段起点=${mid29p2 === before29p2 + 2}`);

// ---- 29u. 续做只做到原窗口的终点：之后追加的内容当新窗口，后面的文件不被饿死
// Codex 第十轮复核：续做的终点每轮延到当前末尾 —— 一直在追加的会话永远处在续做里、每轮都不预筛，
// 按家算的上限又让后面的文件永远轮不到（上限 2、连续 5 轮追加只读内容，第一个文件水位 2/4/6/8/10，后面的文件始终 0）。
appendLines(CT_FILE, [
  userL('续做终点甲：只有这段动过东西'), asstL(`甲。${FILLER.repeat(70)}`, ['Edit']),
  userL('续做终点乙：只读'), asstL(`乙。${FILLER.repeat(70)}`),
  userL('续做终点丙：只读'), asstL(`丙。${FILLER.repeat(70)}`),
]);
const contEnd29u = fullLines(CT_FILE);
fs.writeFileSync(MODE, 'worthless', 'utf8');
resetCalls();
capped(2);                                          // 做两段，第三段留给续做
const afterFirst29u = contOf(CT_FILE);
appendLines(CT_FILE, [                              // 续做之前，第一个文件又追加了两段只读内容
  userL('续做终点丁：之后追加的只读'), asstL(`丁。${FILLER.repeat(70)}`),
  userL('续做终点戊：之后追加的只读'), asstL(`戊。${FILLER.repeat(70)}`),
]);
fs.appendFileSync(CT_FILE2, claudeTurn('续做终点：排在后面的文件也要轮到', ['Edit']), 'utf8');
resetCalls();
capped(2);
const calls29u = calls().length;
const markA29u = markOf(CT_FILE);
const fileBDone = markOf(CT_FILE2) === fullLines(CT_FILE2);
resetCalls();
memo(['scribe']);                                   // 追加的那两段是新窗口：没有写操作，预筛掉，不叫模型
ok('29u 续做只做到原窗口终点：追加的内容另算，后面的文件照样轮到',
  afterFirst29u === contEnd29u && calls29u === 2 && markA29u === contEnd29u && fileBDone
  && calls().length === 0 && markOf(CT_FILE) === fullLines(CT_FILE) && contOf(CT_FILE) === null,
  `续做标记=${afterFirst29u}（应为原窗口终点 ${contEnd29u}）；续做那一轮调模型 ${calls29u} 次（应为 2：第一个文件 1 次 + 后面的文件 1 次）、`
  + `第一个文件水位停在原窗口终点=${markA29u === contEnd29u}、后面的文件做完了=${fileBDone}（旧逻辑是 false）；`
  + `再下一轮调模型 ${calls().length} 次（应为 0：追加的只读内容被预筛掉）`);

// ---- 29v. 模型那边用 GBK 报错（cmd.exe 的「不是内部或外部命令」「系统找不到指定的文件」）：日志里要看得懂
// 2026-10-09 真实库：WMI 起的 worker 找不到 codex.cmd，auto.log 里只有「退出码 1：���」，原因完全看不出来。
fs.appendFileSync(CT_FILE, claudeTurn('模型报错是 GBK 编码时日志要看得懂', ['Edit']), 'utf8');
fs.writeFileSync(MODE, 'crash-gbk', 'utf8');
const r29v = spawnSync(process.execPath, [CLI, 'scribe'], { env: autoEnv, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
fs.writeFileSync(MODE, 'worthless', 'utf8');
memo(['scribe']);                                   // 把回退的那段做完，别留给后面
ok('29v 模型用 GBK 报错：日志里解成中文，不是乱码', r29v.stderr.includes('系统找不到指定的文件'),
  `stderr：${(r29v.stderr.match(/[^\n]*模型调用失败[^\n]*/) || ['（没有调用失败那行）'])[0].slice(0, 90)}`);

// ---- 29v3. 报错有两行、原因在第一行：日志里要留住第一行
// Codex 第十三轮复核：whyFailed 只留最后一行，cmd.exe「'codex.cmd' 不是内部或外部命令，也不是可运行的程序／或批处理文件。」
// 最后只剩「或批处理文件。」—— 命令名和原因都没了。
fs.appendFileSync(CT_FILE, claudeTurn('两行报错时留住第一行', ['Edit']), 'utf8');
fs.writeFileSync(MODE, 'crash-2line', 'utf8');
const r29v3 = spawnSync(process.execPath, [CLI, 'scribe'], { env: autoEnv, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
fs.writeFileSync(MODE, 'worthless', 'utf8');
memo(['scribe']);
ok('29v3 两行报错：日志里第一行的原因和最后一行都在', r29v3.stderr.includes('第一行：真正的原因在这里') && r29v3.stderr.includes('第二行：只是尾巴'),
  `stderr：${(r29v3.stderr.match(/[^\n]*模型调用失败[^\n]*/) || ['（没有调用失败那行）'])[0].slice(0, 90)}`);

// ---- 29v4. 经命令行收提示的模型（dsh 就是这样）：段按命令行预算切，切出来的每段都送得出去；真送不出去也不跳过
// 第十七轮：超长的段直接跳过、水位越过 —— 这段一个字都没送出去，却被当成「看过、不值得记」（第十八轮复核 D）。
const cfg29v4 = fs.readFileSync(path.join(HOME, 'scribes.json'), 'utf8');
const argv29v4 = JSON.parse(cfg29v4);
argv29v4.claude.run = [...runOf('claude'), '{prompt}'];
const useArgv = () => fs.writeFileSync(path.join(HOME, 'scribes.json'), JSON.stringify(argv29v4, null, 2), 'utf8');
const usePlain = () => fs.writeFileSync(path.join(HOME, 'scribes.json'), cfg29v4, 'utf8');
const scribeRun = (env = {}) => spawnSync(process.execPath, [CLI, 'scribe'], {
  env: { ...autoEnv, ...env }, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
});
const readOr = (f, d) => { try { return fs.readFileSync(f, 'utf8'); } catch { return d; } };
// (a) 两轮各 9000 个 "：按字数合起来不到 24000，按转义后的长度放不进一条命令行 → 切成两段，两段都送到，下一轮不重做
useArgv();
fs.appendFileSync(CT_FILE, claudeTurn(`引号很多的第一轮：${'"'.repeat(9000)}`, ['Edit'])
  + claudeTurn(`引号很多的第二轮：${'"'.repeat(9000)}`, ['Edit']), 'utf8');
fs.writeFileSync(MODE, 'worthless', 'utf8');
resetCalls();
const r29v4a = scribeRun();
const n29v4a = calls().length;
resetCalls();
scribeRun();
const a29v4 = n29v4a === 2 && calls().length === 0 && !/送不出去|只看了它的尾部/.test(r29v4a.stderr);
// (b) 真送不出去（故障注入：提示里带某个记号就报 PROMPT_TOO_LONG）：这个文件停在这一段、水位不动，别的文件照常做；
//     故障消失后下一轮把这一段接着做掉
const CT2 = path.join(CT, 'sess9-v4b.jsonl');   // 排在 sess1 后面：卡住的文件先处理，才测得到「卡住不连累后面的文件」
const before29v4b = markOf(CT_FILE);
fs.appendFileSync(CT_FILE, claudeTurn('记号 STUCK-MARK 这一段送不出去', ['Edit']), 'utf8');
fs.writeFileSync(CT2, claudeTurn('另一个会话 OTHER-MARK 照常处理', ['Edit']), 'utf8');
fs.rmSync(path.join(HOME, 'all-scribe.txt'), { force: true });
const r29v4b = scribeRun({ AGENTMEM_FAULT: 'prompt-too-long:STUCK-MARK' });
const allB = readOr(path.join(HOME, 'all-scribe.txt'), '');
const b1 = /送不出去.*水位不动/.test(r29v4b.stderr) && markOf(CT_FILE) === before29v4b && allB.includes('OTHER-MARK');
fs.rmSync(path.join(HOME, 'all-scribe.txt'), { force: true });
scribeRun();
const allC = readOr(path.join(HOME, 'all-scribe.txt'), '');
const b2 = allC.includes('STUCK-MARK') && markOf(CT_FILE) > before29v4b;
// (c) 模型给了一段 35000 字、原文里没有的引文：重问提示里只附前 1000 字，重问照常送出去
fs.writeFileSync(MODE, 'quote-huge', 'utf8');
fs.appendFileSync(CT_FILE, claudeTurn('重问提示不能被错引文撑爆', ['Edit']), 'utf8');
fs.rmSync(path.join(HOME, 'argv-prompt.txt'), { force: true });
resetCalls();
const r29v4d = scribeRun();
const lastArgv = readOr(path.join(HOME, 'argv-prompt.txt'), '');
const c29v4 = calls().length === 2 && lastArgv.includes('你刚才给的引证') && lastArgv.includes('…（后面略）') && !/送不出去/.test(r29v4d.stderr);
usePlain();
fs.writeFileSync(MODE, 'worthless', 'utf8');
ok('29v4 经命令行收提示：按转义后的长度切段、每段都送到；送不出去的段水位不动、别的文件照常做；重问提示不被错引文撑爆',
  a29v4 && b1 && b2 && c29v4,
  `(a) 两段都送到=${a29v4}（第一轮调 ${n29v4a} 次，应为 2）；(b) 停在送不出去的那段、别的文件照做=${b1}，`
  + `下一轮接着做掉=${b2}；(c) 重问送出去且错引文被截短=${c29v4}；`
  + `stderr：${(r29v4a.stderr + r29v4b.stderr + r29v4d.stderr).replace(/\s+/g, ' ').slice(0, 200)}`);

// ---- 29v5. 经命令行收的提示必须和原文一字不差：会话里的 $& $' $` 不能被当成替换模式展开
// String.replace 的第二个参数是字符串时，$& 会变成「匹配到的 {prompt}」、$' 变成空 —— 送给 dsh 的提示被悄悄改了。
argv29v4.claude.run = [...runOf('claude'), '{prompt}'];
fs.writeFileSync(path.join(HOME, 'scribes.json'), JSON.stringify(argv29v4, null, 2), 'utf8');
fs.appendFileSync(CT_FILE, claudeTurn("PowerShell 里 $& 和 $' 还有 $` 都是特殊变量，替换时要小心", ['Edit']), 'utf8');
fs.rmSync(path.join(HOME, 'argv-prompt.txt'), { force: true });
memo(['scribe']);
fs.writeFileSync(path.join(HOME, 'scribes.json'), cfg29v4, 'utf8');
const argvGot = (() => { try { return fs.readFileSync(path.join(HOME, 'argv-prompt.txt'), 'utf8'); } catch { return null; } })();
const stdinGot = fs.readFileSync(path.join(HOME, 'last-scribe.txt'), 'utf8');
ok('29v5 经命令行送的提示和原文一字不差（$& $\' $` 不被展开）', argvGot !== null && argvGot === stdinGot && argvGot.includes("$& 和 $' 还有 $`"),
  `收到了命令行那份=${argvGot !== null}；和 stdin 那份相同=${argvGot === stdinGot}；`
  + `原样保留=${!!argvGot && argvGot.includes("$& 和 $' 还有 $`")}`);

// ---- 29v6. 命令行长度按 libuv 的真实规则算：正好 32767（含结尾 NUL）的送得出去，多一个字就在启动前拦下
// 第十八轮复核：第十七轮按「每个参数都加引号」估，比实际多算几个字，32699 字送得出去的提示被拦下。
// 长度公式照 libuv src/win/process.c 的 quote_cmd_arg 在这里另写一份（不用被测代码里那份），再让真实的 Windows 判：
// 估少了，正好 32767 那次进程起不来（ENAMETOOLONG）；估多了，那次被预检拦下 —— 两种都会让这条变红。
const qlen = (s) => {
  if (s === '') return 2;
  if (!/[ \t"]/.test(s)) return s.length;
  if (!/["\\]/.test(s)) return s.length + 2;
  let out = 2; let hit = true;
  for (let k = s.length - 1; k >= 0; k--) {
    out += 1;
    if (hit && s[k] === '\\') out += 1;
    else if (s[k] === '"') { hit = true; out += 1; } else hit = false;
  }
  return out;
};
const lineLen = (argv) => argv.reduce((n, s) => n + qlen(s), 0) + argv.length;   // 参数间的空格 + 结尾的 NUL
const cfg29v6 = JSON.parse(cfg29v4);
// 再带两个固定参数，让每一种加引号的情形都出现在这条命令行里：带空格不带引号的（两头加引号）、空串（写成 ""）。
// 只有提示一个参数时它总带 "，只走最复杂的那一支 —— 把「带空格」那一支少算两个字，这条照样绿（变异验证）。
cfg29v6.codex.run = [...runOf('codex'), 'has space', '', '{prompt}'];
fs.writeFileSync(path.join(HOME, 'scribes.json'), JSON.stringify(cfg29v6, null, 2), 'utf8');
fs.writeFileSync(MODE, 'reject', 'utf8');
const probe29v6 = (k) => {
  fs.rmSync(PEND, { recursive: true, force: true });
  plantAs('v6', 'claude', { title: '命令行长度边界', text: 'a'.repeat(k) });
  fs.rmSync(path.join(HOME, 'argv-prompt.txt'), { force: true });
  resetCalls();
  const r = runReview();
  const got = readOr(path.join(HOME, 'argv-prompt.txt'), null);
  return { r, called: whoCalled('codex'), len: got === null ? null : lineLen(cfg29v6.codex.run.map((x) => (x === '{prompt}' ? got : x))) };
};
const p0 = probe29v6(100);
const k1 = p0.len === null ? 0 : 100 + (32767 - p0.len);
const p1 = probe29v6(k1);
const p2 = probe29v6(k1 + 1);
fs.writeFileSync(path.join(HOME, 'scribes.json'), cfg29v4, 'utf8');
fs.rmSync(PEND, { recursive: true, force: true });
fs.writeFileSync(MODE, 'worthless', 'utf8');
const v6ok = p0.called === 1 && p1.called === 1 && p1.len === 32767 && !/PROMPT_TOO_LONG|ENAMETOOLONG/.test(p1.r.stderr)
  && p2.called === 0 && /PROMPT_TOO_LONG/.test(p2.r.stderr);
ok('29v6 命令行正好 32767 字（含 NUL）送得出去，多一个字在启动前拦下', v6ok,
  `基准 ${p0.len} 字；32767 那次：叫了 ${p1.called} 次、长度 ${p1.len}；多一字那次：叫了 ${p2.called} 次；`
  + `stderr：${(p1.r.stderr + p2.r.stderr).replace(/\s+/g, ' ').slice(0, 160)}`);

// ---- 29q2. 引证：交给审核者、写进留档的必须是**原文**，不是模型写的引文；编造的短尾巴必须挡掉
// Codex 第十三轮复核（严重，旧缺陷）：引证核对删掉了所有空白和引号 —— 原文 VALUE="a b"、模型写 VALUE="ab" 照样通过，
// 还告诉审核者「已逐字核对」，审核者看到的是改过的值，错值进了 log；省略号隔开的片段不足 6 字就被忽略，
// 真实前缀后面接一个编造的「…9999」也算真引证。
fs.writeFileSync(MODE, 'quote-ab', 'utf8');
fs.appendFileSync(CT_FILE, claudeTurn('VALUE="a b" 设置之后服务起不来', ['Edit']), 'utf8');
memo(['scribe']);
const abCand = pendingCands().find((c) => c.title.includes('设置之后服务起不来'));
fs.writeFileSync(MODE, 'accept', 'utf8');
fs.rmSync(path.join(HOME, 'last-review.txt'), { force: true });
memo(['review']);
let review29q2 = '';
try { review29q2 = fs.readFileSync(path.join(HOME, 'last-review.txt'), 'utf8'); } catch { /* 没审 */ }
const excerpt29q2 = review29q2.split('【原文摘段】')[1] || '';
const abOk = !!abCand && abCand.quotes.join('').includes('VALUE="a b"') && !abCand.quotes.join('').includes('VALUE="ab"')
  && (abCand.modelQuotes || []).join('').includes('VALUE="ab"') && excerpt29q2.includes('VALUE="a b"');
fs.writeFileSync(MODE, 'quote-fake-tail', 'utf8');
fs.appendFileSync(CT_FILE, claudeTurn('真实前缀后面接一个编造的数字', ['Edit']), 'utf8');
const quoteRejBefore = rejEntries().filter((r) => r.rejectedBy === 'script:quote').length;
resetCalls();
memo(['scribe']);
const fakeTail = pendingCands().find((c) => c.title.includes('编造的数字'));
const tailOk = !fakeTail && calls().length === 2 && rejEntries().filter((r) => r.rejectedBy === 'script:quote').length === quoteRejBefore + 1;
ok('29q2 引证：留档和审核看到的是原文（"a b"），不是模型改过的（"ab"）；编造的「…9999」被挡掉', abOk && tailOk,
  `候选的引证是原文、模型的引文另存=${abOk}（旧逻辑交出去的是 "ab"）；`
  + `编造尾巴：没发布、重问了一次、留档 script:quote=${tailOk}（旧逻辑不足 6 字的片段被忽略、照样发布）`);
fs.rmSync(PEND, { recursive: true, force: true });
fs.writeFileSync(MODE, 'accept', 'utf8');

// ---- 29q4. 原文摘段要带上下文、不能切断一个词、要挑逐字相同的那一处（Codex 第十四轮复核，三个反例）
//   · 省略号吞掉否定：原文「必须为3001，绝对不能设为9999」，引文「必须为…9999」—— 摘段必须把中间那段也给出来；
//   · 截断数字：原文 timeout=1000，引文 timeout=1 —— 切在数字中间，当作没找到（重问一次后挡掉）；
//   · 同一个值两处：原文先有 VALUE="a b"、后有 VALUE="ab"，引文 VALUE="ab" —— 要挑后面逐字相同的那一处。
// 第十五轮复核又给了四个：
//   · 否定在上一句（「以下配置禁止使用。\n配置参数 timeout=1000 毫秒。」）—— 摘段要多带一句；
//   · 扩展本身截断数字：引文完整，往外扩 80 字正好停在 1000 中间只剩 10 —— 扩展停在数字上要补完；
//   · 前一处截断数字、后一处才合法（timeout=1000 … timeout=1）—— 要跳过前一处接着找，不能直接判失败；
//   · 审核者真正收到的提示里也得有这些（原来只查 pending，审核前再裁一次照样通过）。
fs.writeFileSync(MODE, 'quote-file', 'utf8');
const quoteCase = (userText, quotes, { review = false } = {}) => {
  fs.writeFileSync(path.join(HOME, 'quotes.json'), JSON.stringify(quotes), 'utf8');
  fs.appendFileSync(CT_FILE, claudeTurn(userText, ['Edit']), 'utf8');
  resetCalls();
  memo(['scribe']);
  const c = pendingCands().find((x) => (x.modelQuotes || [])[0] === quotes[0]);
  const n = calls().length;
  let prompt = '';
  if (review && c) {
    fs.rmSync(path.join(HOME, 'last-review.txt'), { force: true });
    memo(['review']);
    try { prompt = fs.readFileSync(path.join(HOME, 'last-review.txt'), 'utf8'); } catch { /* 没审 */ }
  }
  fs.rmSync(PEND, { recursive: true, force: true });
  return { cand: c, calls: n, prompt };
};
// 只看提示里【原文摘段】那一节：桩的标题和正文是拿用户原话拼的，整份提示里搜会被标题满足
// （第十七轮复核：审核前把摘段里的否定删掉，整份 prompt.includes 照样通过）
const section = (prompt) => (prompt.split('【原文摘段】')[1] || '').split('【库里已有')[0];
const neg = quoteCase('配置端口必须为3001，绝对不能设为9999。', ['配置端口必须为…9999'], { review: true });
const negOk = !!neg.cand && neg.cand.quotes.join('').includes('3001，绝对不能设为9999') && section(neg.prompt).includes('3001，绝对不能设为9999');
const cutRejBefore = rejEntries().filter((r) => r.rejectedBy === 'script:quote').length;
const cutNum = quoteCase('参数配置 timeout=1000 毫秒，仅用于本地。', ['参数配置 timeout=1']);
const cutOk = !cutNum.cand && cutNum.calls === 2 && rejEntries().filter((r) => r.rejectedBy === 'script:quote').length === cutRejBefore + 1;
// 两处拉开两句以上：摘段多带的那一句够不着前一处，选错了位置才会把 "a b" 带进来
// 每个场景都核对**审核者实际收到的提示**（第十六轮复核：只有第一个场景跑了 review，其余只查 pending，审核前再裁一次照样通过；
// 第十八轮复核：这一个场景当时还是只查 pending）
const inPrompt = (r, s) => !!r.cand && r.cand.quotes.join('').includes(s) && section(r.prompt).includes(s);
const two = quoteCase('旧配置 VALUE="a b" 不可用。中间隔一句。再隔一句。新配置 VALUE="ab" 已验证可用。', ['VALUE="ab"…已验证可用'], { review: true });
const twoOk = inPrompt(two, 'VALUE="ab" 已验证可用') && !two.cand.quotes.join('').includes('VALUE="a b"') && !section(two.prompt).includes('VALUE="a b"');
const prev = quoteCase('以下配置禁止使用。\n配置参数 timeout=1000 毫秒。', ['配置参数 timeout=1000 毫秒'], { review: true });
const prevOk = inPrompt(prev, '以下配置禁止使用');
// 值放在锚点后第 198 字起：上下文扩到 200 字时正好停在 1000 中间，**必须靠补完**才看得到完整值
// （第十六轮复核：原来放在 78 字处，200 字的上下文本来就覆盖了，把补完关掉照样通过）
const head = '本次部署所有服务的运行参数统一使用如下配置说明：';
const widenCase = quoteCase(`${head}参${'数'.repeat(196)}值=1000毫秒。`, [head], { review: true });
const widenOk = inPrompt(widenCase, '值=1000');
const later = quoteCase('旧参数配置 timeout=1000 毫秒。新参数配置 timeout=1 毫秒。', ['参数配置 timeout=1'], { review: true });
const laterOk = inPrompt(later, '新参数配置 timeout=1 毫秒');
ok('29q4 原文摘段（审核者实际收到的）：省略的否定、上一句的否定都在，截断数字被挡，扩展不截断值，挑对位置',
  negOk && cutOk && twoOk && prevOk && widenOk && laterOk,
  `省略号中间的否定在摘段和审核提示里=${negOk}；timeout=1 被挡=${cutOk}；挑了后面逐字相同的 VALUE="ab"=${twoOk}；`
  + `上一句的「禁止使用」=${prevOk}；扩展停在 1000 中间时补完=${widenOk}；前一处截断、后一处合法时找到了后一处=${laterOk}`);

// ---- 29q5. 句界不能把字面值切坏：路径里的 !、闭引号后的换行、扩完重叠的区段（Codex 第十六、十七轮复核）
//   · C:/foo!bar!secret 里的 ! 被当成句末，摘段停在 C:/foo!bar!，后缀没了也没有 …；
//     第十七轮：! 后面是中文、$、全角空格时照样被截（C:/foo!目录!私密、https://x.test/a?甲?私密、"foo!　bar!　secret"）；
//   · 值里本身带中文句末（"甲！乙！丙"）：可以停在里面，但必须标 …，不能装作是完整的值；
//   · 「“以下配置禁止使用。”\n配置参数…」闭引号把一个边界拆成两个，上一句没带上；
//   · 两段扩完重叠，显示成「中间隔了 -159 字」、原文重复。第十七轮：原夹具间隔 390 ≤ 400，扩展前就合并了，
//     根本没走到「扩完再合并」—— 间隔要超过 400、靠扩展（含补完半个词）才碰到一起。
const bangs = [
  ['配置目录路径为 C:/foo!bar!secret 不要动', 'C:/foo!bar!secret'],
  ['配置目录路径为 C:/foo!目录!私密 不要动', 'C:/foo!目录!私密'],
  ['配置回调地址为 https://x.test/a?甲?私密 不要动', 'https://x.test/a?甲?私密'],
  ['配置目录路径为 C:/foo!$bar!$secret 不要动', 'C:/foo!$bar!$secret'],
  ['配置口令取值为 "foo!　bar!　secret" 不要动', '"foo!　bar!　secret"'],
].map(([text, val]) => [val, inPrompt(quoteCase(text, [text.slice(0, 7)], { review: true }), val)]);
const bangOk = bangs.every(([, v]) => v);
const zh = quoteCase('配置口令取值为 "甲！乙！丙" 不要动', ['配置口令取值为'], { review: true });
const zhSec = section(zh.prompt);
const zhOk = !!zh.cand && (zhSec.includes('"甲！乙！丙"') || zhSec.includes('乙！…'));
const closeQ = quoteCase('“以下配置禁止使用。”\n配置参数 timeout=2000 毫秒。', ['配置参数 timeout=2000 毫秒'], { review: true });
const closeOk = inPrompt(closeQ, '以下配置禁止使用');
// 间隔 450 字全是同一个英文词：两头各扩 200 字到上限、再各补完 80 字，碰到一起
const overlap = quoteCase(`重叠前一句。甲甲甲甲甲甲甲${'x'.repeat(450)}丙丙丙丙丙丙。重叠后一句。`, ['甲甲甲甲甲甲甲…丙丙丙丙丙丙'], { review: true });
const ovSec = section(overlap.prompt);
const overlapOk = !!overlap.cand && !/中间隔了/.test(ovSec) && (ovSec.match(/甲甲甲甲甲甲甲/g) || []).length === 1 && ovSec.includes('丙丙丙丙丙丙');
// 六段相隔 450 字的引文：带 200 字上下文会超过 2000 字，收窄到 60 字 —— 收窄之后每段两头照样要标 …
// （第十八轮复核：把收窄时的 … 去掉，这一组测试照样全绿）
const anchors = ['锚点甲一号段落', '锚点乙二号段落', '锚点丙三号段落', '锚点丁四号段落', '锚点戊五号段落', '锚点己六号段落'];
const narrow = quoteCase(`${'乙'.repeat(300)}${anchors.map((a) => a + '乙'.repeat(450)).join('')}`, [anchors.join('…')], { review: true });
const narSec = section(narrow.prompt);
const narrowOk = !!narrow.cand && narSec.length < 2500 && anchors.every((a) => new RegExp(`…乙+${a}乙+…`).test(narSec));
ok('29q5 句界：路径 / URL / 引号里的 ! ? 不算句末、值里的中文句末要标 …、闭引号不拆边界、扩完重叠的合并、收窄后照样标 …',
  bangOk && zhOk && closeOk && overlapOk && narrowOk,
  `值完整：${bangs.map(([v, b]) => `${v}=${b}`).join('，')}；"甲！乙！丙" 完整或标了 …=${zhOk}；`
  + `闭引号前的上一句带上了=${closeOk}；间隔 450 扩完重叠的合成一段=${overlapOk}；`
  + `收窄后六段两头都有 …=${narrowOk}（摘段 ${narSec.length} 字）`);
fs.writeFileSync(MODE, 'accept', 'utf8');

// ---- 29q6. 旧版本的候选：审核前能重新摘就重新摘，摘不了就当未核对
// Codex 第十六轮复核：v2 的摘段是用有缺陷的旧逻辑截的（1000 被截成 10），存量的 v2 候选照样被当成可信原文。
// 第十八轮复核：第十七轮改了句界却没升版本，已落盘的 v3（C:/foo!目录! 截掉了「私密」、不标 …）照样被担保；
// 内容核对只比 excerpt 的结尾，两个字的 excerpt、或者 3000 字以外的前部被改，都照样升级。
// 先让 scribe 产出真实候选（当前版本，带 windowSha），再改写成各种「旧版本」放回 pending 审一次。
const VOUCH = /可以当作事实|逐字出自原文|原样摘出|已逐字核对/;
// 降级的提示里**一句担保都不能有**（第十七轮复核：只查章节名，给失败的旧版本前面加一句「已逐字核对、可以当事实」照样通过）
const unverified = (pr) => pr.includes('【候选给的引文】') && !pr.includes('【原文摘段】') && pr.includes('不能当事实') && !VOUCH.test(pr);
const reviewCand = (c) => {
  fs.rmSync(PEND, { recursive: true, force: true });
  fs.mkdirSync(PEND, { recursive: true });
  fs.writeFileSync(path.join(PEND, `${c.id}.json`), JSON.stringify(c), 'utf8');
  fs.rmSync(path.join(HOME, 'last-review.txt'), { force: true });
  memo(['review']);
  try { return fs.readFileSync(path.join(HOME, 'last-review.txt'), 'utf8'); } catch { return ''; }
};
// 改写成旧版本：去掉 windowSha（JSON 里 undefined 不落盘），换版本号和 quotes
const legacy = (cand, over) => ({ ...cand, id: crypto.randomUUID(), windowSha: undefined, quoteFormat: 'source-span-v3', ...over });
fs.writeFileSync(MODE, 'quote-file', 'utf8');
const realQ = quoteCase('本机缓存目录为 C:/foo!目录!私密 不要动', ['本机缓存目录为']);
const LONG_FILL = '乙'.repeat(3500);
const front = quoteCase(`前部：禁止用于生产环境。${LONG_FILL}尾部之前的一句话。`, ['前部：禁止用于生产环境']);
const back = quoteCase(`前部的另一种写法。${LONG_FILL}尾部：允许用于测试环境。`, ['尾部：允许用于测试环境']);
fs.writeFileSync(MODE, 'reject', 'utf8');                // 驳回：不往 log 里写东西，免得影响后面的测试
const made29q6 = !!realQ.cand && !!front.cand && !!back.cand && typeof realQ.cand.windowSha === 'string';
// ① 已落盘的 v3：截坏的值、没有 …。源还在、窗口结尾和 excerpt 整段相等 → 按现在的规则重摘，看得到「私密」
const pV3 = made29q6 ? reviewCand(legacy(realQ.cand, { quotes: ['用户：本机缓存目录为 C:/foo!目录!'] })) : '';
const v3Ok = section(pV3).includes('C:/foo!目录!私密');
// ② excerpt 只剩两个字（只比结尾时能过）→ 不升级
const pShort = made29q6 ? reviewCand(legacy(realQ.cand, { excerpt: realQ.cand.excerpt.slice(-2) })) : '';
// ③ 有 windowSha 但对不上（会话被同路径重写）→ 不升级
const pSha = made29q6 ? reviewCand(legacy(realQ.cand, { windowSha: 'f'.repeat(64) })) : '';
// ④ 窗口超过 3000 字、没有 windowSha：前部核对不了 —— 引文落在前部的不升级，落在最后 3000 字里的照常升级
const pFront = made29q6 ? reviewCand(legacy(front.cand, {})) : '';
const pBack = made29q6 ? reviewCand(legacy(back.cand, {})) : '';
const backOk = section(pBack).includes('尾部：允许用于测试环境');
// ⑤ 窗口坐标越界（会话被截短）→ 不升级
const pBad = made29q6 ? reviewCand(legacy(realQ.cand, { window: [realQ.cand.window[0] + 500, realQ.cand.window[0] + 501] })) : '';
ok('29q6 旧版本候选：源还在、内容整段核对得上才按现在的规则重摘（含已落盘的 v3）；核对不了的标成未核对，提示里没有担保',
  made29q6 && v3Ok && unverified(pShort) && unverified(pSha) && unverified(pFront) && backOk && unverified(pBad),
  `产出了真实候选=${made29q6}；v3 截坏的值重摘成完整的=${v3Ok}；两字 excerpt 没升级=${unverified(pShort)}；`
  + `windowSha 对不上没升级=${unverified(pSha)}；长窗口前部的没升级=${unverified(pFront)}、尾部的升级了=${backOk}；`
  + `坐标越界没升级=${unverified(pBad)}`);
fs.rmSync(PEND, { recursive: true, force: true });
fs.writeFileSync(MODE, 'accept', 'utf8');

// ---- 29q3. 旧版候选（没有回填原文）：审核提示不能把它的引文当「原文摘段」担保
// 升级前产出的候选 quotes 是模型自己写的引文。新提示说「原文摘段可当事实」，套在旧候选上就又替改写过的引文担保了一次。
// plant 放的就是这种旧格式（没有 modelQuotes）。
plant('旧版候选的引文不能当原文');
fs.rmSync(path.join(HOME, 'last-review.txt'), { force: true });
memo(['review']);
let review29q3 = '';
try { review29q3 = fs.readFileSync(path.join(HOME, 'last-review.txt'), 'utf8'); } catch { /* 没审 */ }
// 整段提示都不能担保：Codex 第十四轮复核 —— 开头那句「原文摘段可以当作事实」无条件出现，下面又说「不能当事实」，原断言没管开头
// 各种担保说法都算（Codex 第十五轮复核：第十四轮原话「所有引文已经逐字核对，可以当作事实，不必怀疑」原正则漏了）
const vouches29q3 = /可以当作事实|按位置原样摘出|【原文摘段】|逐字核对|不必怀疑|不需要怀疑/.test(review29q3);
ok('29q3 旧版候选：整段审核提示都不替它的引文担保', review29q3.includes('没有') && review29q3.includes('按原文回填') && !vouches29q3,
  `标明了没回填=${review29q3.includes('按原文回填')}；提示里有担保原文的话=${vouches29q3}（应为 false）`);
fs.rmSync(PEND, { recursive: true, force: true });

// ---- 29q. codex 的同一条消息记了两次（response_item + item_completed）：不管切在哪，都只送一次
// 第九轮复核：去重原来只在一次提取的范围内，切段之后两条记录分到两段，各送一遍模型，最后同文不同 id 两条都进了库。
// 窗口边界切在两条之间时同理。现在按整个文件只认第一次出现。
const xLine = (payload) => JSON.stringify({ type: 'response_item', payload });
const Q_MARK = '〔二九q-问〕'; const A_MARK = '〔二九q-答〕'; const Q2_MARK = '〔二九q-再问〕';
const qText = `${Q_MARK}codex 里同一条消息记两次。${FILLER.repeat(70)}`;     // 约 1.3 万字：两份装不进一段，一份装得下
const aText = `${A_MARK}按 id 只认第一次出现。${FILLER}`;
fs.writeFileSync(MODE, 'accept', 'utf8');
fs.appendFileSync(XT_FILE, `${[
  xLine({ type: 'message', role: 'user', id: 'q29-1', content: [{ type: 'input_text', text: qText }] }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'q29-1', content: [{ type: 'input_text', text: qText }] } } }),
  xLine({ type: 'agent_message', id: 'q29-2', content: [{ type: 'input_text', text: aText }] }),
  xLine({ type: 'custom_tool_call', name: 'apply_patch', input: 'x' }),
].join('\n')}\n`, 'utf8');
fs.rmSync(path.join(HOME, 'all-scribe.txt'), { force: true });
memo(['scribe']);
const fedA = fedPrompts();
const qTimes = fedA.reduce((n, x) => n + x.split(Q_MARK).length - 1, 0);
// 第二次：答的那条的另一份记录落在新窗口里，后面跟一个新问题
fs.appendFileSync(XT_FILE, `${[
  JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'q29-2', content: [{ type: 'input_text', text: aText }] } } }),
  xLine({ type: 'message', role: 'user', id: 'q29-3', content: [{ type: 'input_text', text: `${Q2_MARK}窗口边界切在两条记录之间也只送一次。${FILLER}` }] }),
  xLine({ type: 'custom_tool_call', name: 'apply_patch', input: 'x' }),
].join('\n')}\n`, 'utf8');
fs.rmSync(path.join(HOME, 'all-scribe.txt'), { force: true });
memo(['scribe']);
const fedB = fedPrompts();
const aAgain = fedB.some((x) => x.includes(A_MARK));
const q2Seen = fedB.some((x) => x.includes(Q2_MARK));
ok('29q codex 同一条消息的两条记录：段内、跨段、跨窗口都只送一次', qTimes === 1 && !aAgain && q2Seen,
  `问的那条在第一轮输入里出现 ${qTimes} 次（应为 1，旧逻辑切段后是 2）；`
  + `答的那条在下一个窗口里又送了一次=${aAgain}（应为 false）；新问题送了=${q2Seen}`);
fs.rmSync(PEND, { recursive: true, force: true });

// ---- 29r. 没审过的候选不能拿来压新候选
// 上一版（第九轮之后）去重同时比对 pending，Codex 第十轮复核推翻：旧窗口产了一条引证很弱的候选，新窗口给出同一件事的
// 强引证，被判「已记过」、水位越过；之后弱的那条被驳回，强的那条再也没有机会（最终 log 0、pending 0）。
// 现在去重只看已进库的。桩的 dup 模式不管输入是什么都吐同一条；两段会话先后各产一条，审核先驳回一条、再通过另一条。
fs.writeFileSync(MODE, 'dup', 'utf8');
fs.appendFileSync(CT_FILE, claudeTurn('同一件事第一次：弱引证', ['Edit']), 'utf8');
memo(['scribe']);
const first29r = jsons().length;
fs.appendFileSync(CT_FILE2, claudeTurn('同一件事第二次：强引证', ['Edit']), 'utf8');
memo(['scribe']);
const both29r = jsons().length;
const logBefore29r = countLog('claude');
fs.writeFileSync(MODE, 'reject-once', 'utf8');
gate.reset();
memo(['review']);
ok('29r 没审过的候选不压新候选：一条被驳回，另一条照样进库', first29r === 1 && both29r === 2
  && countLog('claude') === logBefore29r + 1 && countDir('pending') === 0,
  `第一次 pending ${first29r} 条；第二次 ${both29r} 条（应为 2，旧逻辑被判「已记过」只剩 1）；`
  + `审核驳回一条之后进库 ${countLog('claude') - logBefore29r} 条（应为 1，旧逻辑 0）`);
fs.rmSync(PEND, { recursive: true, force: true });
fs.writeFileSync(MODE, 'accept', 'utf8');

// ---- 29w. 和库里某条很像（≥ 0.96）但讲的是另一件事：不能直接当「已记过」丢掉，交给审核者对着那条判
// Codex 第十轮量到、第十一轮端到端复现：A（端口 3001）入库之后，B（端口 3002）被判「已记过」—— 水位越过、候选没了。
// 现在只有逐字相同才直接挡；很像的照常发布，把库里那条一起给审核者（审核 prompt 里有「库里已有的一条很像的记忆」）。
// 桩的正文是同一个模板，两段只差服务器和端口，实测余弦远高于 0.96。
fs.rmSync(PEND, { recursive: true, force: true });
fs.writeFileSync(MODE, 'accept', 'utf8');
fs.appendFileSync(CT_FILE, claudeTurn('A 服务器的服务端口改成 3001', ['Edit']), 'utf8');
memo(['scribe']);
memo(['review']);                                        // A 进库
const aRec = (() => { try { return fs.readFileSync(path.join(HOME, 'log', 'claude.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.title && r.title.includes('3001')).pop(); } catch { return null; } })();
fs.appendFileSync(CT_FILE, claudeTurn('B 服务器的服务端口改成 3002', ['Edit']), 'utf8');
const out29w = memo(['scribe']);
const bCand = pendingCands().find((c) => c.title.includes('3002'));
fs.rmSync(path.join(HOME, 'last-review.txt'), { force: true });
memo(['review']);
let review29w = '';
try { review29w = fs.readFileSync(path.join(HOME, 'last-review.txt'), 'utf8'); } catch { /* 没审 */ }
// 审核者要看到的是库里那条的**正文**（不只是标题）：Codex 第十二轮复核把 similar.text 清空，原断言照样通过 ——
// 因为 3001 在标题里就有。所以断言「库里那条」那一段里有 A 的完整正文。
const simSection = review29w.split('【库里已有的一条很像的记忆】')[1] || '';
const sawABody = !!aRec && simSection.includes(aRec.text) && simSection.includes(aRec.title);
ok('29w 和库里那条很像但不是同一件事：照常发布，审核者看得到库里那条的正文', !!aRec && !!bCand && !/已记过/.test(out29w)
  && bCand.similar && bCand.similar.id === aRec.id && sawABody,
  `A 进库=${!!aRec}；B 发布了=${!!bCand}（旧逻辑判「已记过」丢掉）；B 带着 A 的 id 和相似度=${!!(bCand && bCand.similar && aRec && bCand.similar.id === aRec.id)}`
  + `（${bCand && bCand.similar ? bCand.similar.score : '-'}）；审核 prompt 里「库里那条」一段有 A 的标题和正文=${sawABody}`);
fs.rmSync(PEND, { recursive: true, force: true });

// ---- 29z. 「逐字相同」就是逐字相同：只差一个内部空格的两段不是同一段
// Codex 第十二轮复核：判定用了引证核对的 norm（删掉所有空白和引号），VALUE="a b" 和 VALUE="ab" 被当成相同、丢掉。
// 库里此时有 29r 进库的那条 dup；dup-nospace 只把正文里「memo add」的空格去掉。
fs.writeFileSync(MODE, 'dup-nospace', 'utf8');
fs.appendFileSync(CT_FILE, claudeTurn('只差一个空格的那条', ['Edit']), 'utf8');
const out29z = memo(['scribe']);
const nospace = pendingCands().find((c) => c.text.includes('memoadd'));
ok('29z 只差一个内部空格：不算逐字相同，照常发布（带着库里那条交给审核）', !!nospace && !/已记过/.test(out29z) && !!(nospace && nospace.similar),
  `发布了=${!!nospace}（旧逻辑删掉空格后判成相同、丢掉）；带着库里那条=${!!(nospace && nospace.similar)}`);
fs.rmSync(PEND, { recursive: true, force: true });

// ---- 29v2. 合法 UTF-8 里夹一个字面的 �：不能把整段当 GBK 解坏
// Codex 第十二轮复核：上一版看「解出来的字里有没有 �」，模型在 JSON 前的废话里吐一个就会整段转坏、引证对不上、候选被误驳。
fs.writeFileSync(MODE, 'accept-fffd', 'utf8');
fs.appendFileSync(CT_FILE, claudeTurn('输出里夹着替换符的那条', ['Edit']), 'utf8');
resetCalls();
memo(['scribe']);
const fffdCand = pendingCands().find((c) => c.title.includes('输出里夹着替换符的那条'));
ok('29v2 输出里有字面的 �：照常按 UTF-8 解，候选正常产出、不重问', !!fffdCand && calls().length === 1,
  `候选产出=${!!fffdCand}（旧逻辑整段当 GBK 解坏、引证对不上被驳）；调模型 ${calls().length} 次（应为 1）`);
fs.rmSync(PEND, { recursive: true, force: true });
fs.writeFileSync(MODE, 'accept', 'utf8');

// ---- 29s. 单独一行就超过上限：只能截断，但必须报出来（报对文件、报对行号）
// 唯一还会丢内容的情况（README 已知边界）。第九轮复核：运行中没有任何诊断，水位照常越过。
const lines29s = fullLines(CT_FILE);
fs.appendFileSync(CT_FILE, `${userL('超长单行')}\n${asstL(`超长。${'长'.repeat(30000)}`, ['Edit'])}\n`, 'utf8');
const r29s = spawnSync(process.execPath, [CLI, 'scribe'], { env: autoEnv, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
const want29s = `${path.basename(CT_FILE)} 第 ${lines29s + 2} 行单独就有`;
ok('29s 单独一行超过上限：截断并在 stderr 报出文件和行号', r29s.stderr.includes(want29s),
  `应报「${want29s}」；实际：${(r29s.stderr.match(/[^\n]*单独就有[^\n]*/) || ['无'])[0].slice(0, 70)}`);
fs.rmSync(PEND, { recursive: true, force: true });

// ---- 29x. 不足 200 字的短尾：会话还在写时先等着，停了两小时以上就照常送一次
// Codex 第十一轮复核：短窗口「水位不动、等攒够」之后，会话停在短尾上的话那段永远不送 —— dsh 会话最后单出来的一轮就是这样。
fs.writeFileSync(MODE, 'worthless', 'utf8');
appendLines(CT_FILE, [userL('短尾'), asstL('改了一行。', ['Edit'])]);
resetCalls();
memo(['scribe']);
const waited29x = calls().length === 0 && markOf(CT_FILE) < fullLines(CT_FILE);
const old = new Date(Date.now() - 3 * 3600 * 1000);
fs.utimesSync(CT_FILE, old, old);                        // 会话已经三小时没动静
resetCalls();
memo(['scribe']);
const flushed29x = calls().length === 1 && markOf(CT_FILE) === fullLines(CT_FILE);
resetCalls();
memo(['scribe']);
ok('29x 短尾：会话还在写时等着，停了两小时以上照常送一次，之后不再重送', waited29x && flushed29x && calls().length === 0,
  `刚写完时没叫模型、水位没动=${waited29x}；停了 3 小时之后叫了一次、水位到末尾=${flushed29x}（旧逻辑永远不送）；再跑叫模型 ${calls().length} 次（应为 0）`);
fs.writeFileSync(MODE, 'accept', 'utf8');

// ---- 29t. dsh：真实尺寸的新轮次、还没结束的一轮、旧切法留下的水位
// 第九轮复核（严重，旧缺陷）：dsh 的伪行是 [首条, 各轮…, 待办, 动过]，新的一轮插在「待办、动过」前面，
// 扫过一次之后再多一轮，slice(水位) 只剩「动过」—— 新的一轮从来没送进模型、水位却越过了它。
// 第十轮复核：上一版这条用了远超真实的轮次长度，遮住了两个严重问题：
//   · 真实 dsh 的轮次概要提问截断到 50 字、回答 120 字，单独一轮最多 177 字，不足 200 字被越过（永远看不到）；
//   · 旧水位换算「旧切法下现在的长度」—— dsh 每轮开始清空待办，长度不变而多了一轮，那一轮被越过。
// 所以轮次都按真实上限截断。另起一个只有 dsh 的临时库。
const HOME_D = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmem-dsh-'));
const DSH_D = path.join(HOME_D, 'dsh');
fs.mkdirSync(DSH_D, { recursive: true });
fs.writeFileSync(path.join(HOME_D, 'scribes.json'), JSON.stringify({
  claude: { model: 'stub', format: 'claude', transcripts: [path.join(HOME_D, 'none', '*.jsonl')], run: runOf('claude') },
  dsh: { model: 'stub', format: 'dsh', transcripts: [path.join(DSH_D, '*.json')], run: ['node', STUB, 'dsh'] },
}, null, 2), 'utf8');
const dshEnv = { ...autoEnv, AGENTMEM_HOME: HOME_D };
const dshScribe = (extra = [], env = {}) => spawnSync(process.execPath, [CLI, 'scribe', ...extra],
  { env: { ...dshEnv, ...env }, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
// 真实 dsh 的截断：末尾带 …
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const T = (k) => ({
  full: `〔dsh-${k}〕第 ${k} 轮的提问：${FILLER}`,
  prompt: cut(`〔dsh-${k}〕第 ${k} 轮的提问：${FILLER}`, 50),
  response: cut(`〔dsh-${k}-答〕${FILLER}`, 120),
});
// turns: T(k) 的数组；open = 还没结束的那一轮的 seq（turnBoundary.openTurnStartSeq）；todos = 待办（dsh 每轮开始会清空）
const dshWrite = (file, turns, { open = null, todos = [{ content: '一项待办', status: 'in_progress' }] } = {}) => fs.writeFileSync(file, JSON.stringify({ record: {
  identity: { cwd: 'C:\\x' },
  rows: {
    titleInput: { val: { first: { text: turns[0].full } } },
    turnOutline: { val: { turns: turns.map((t, i) => ({ turn: i + 1, seq: (i + 1) * 10, prompt: t.prompt, response: t.response })) } },
    turnBoundary: { val: { openTurnStartSeq: open } },
    sessionStats: { val: { toolMs: 1200 } },
    todos: { val: todos },
  },
} }), 'utf8');
const dshMarkOf = (file) => {
  const m = JSON.parse(fs.readFileSync(path.join(HOME_D, 'scribemark.json'), 'utf8'));
  return { mark: m[file], layout: (m['#layout'] || {})[file] };
};
const fedNow = () => fedPrompts().join('\n=====\n');
const freshRun = (extra, env) => { resetCalls(); fs.rmSync(path.join(HOME, 'all-scribe.txt'), { force: true }); return dshScribe(extra, env); };

// 一、新的一轮：单独一轮不足 200 字 → 水位不动、等下一轮；两轮攒够了一起送
const D1 = path.join(DSH_D, 'session-grow.json');
dshWrite(D1, [T(1)]);
dshScribe(['--init']);
dshWrite(D1, [T(1), T(2)]);
freshRun();
const waited = calls().length === 0 && dshMarkOf(D1).mark === 1;
dshWrite(D1, [T(1), T(2), T(3)]);
freshRun();
const grow = waited && calls().length === 1 && fedNow().includes('〔dsh-2〕') && fedNow().includes('〔dsh-3〕')
  && !fedNow().includes('〔dsh-1〕') && dshMarkOf(D1).mark === 3;
// 二、还没结束的一轮：不算；结束之后它的回答要被读到
dshWrite(D1, [T(1), T(2), T(3), { full: '', prompt: cut(`〔dsh-4〕第 4 轮的提问：${FILLER}`, 50), response: '' }], { open: 40 });
freshRun();
const openSkipped = calls().length === 0 && dshMarkOf(D1).mark === 3;
dshWrite(D1, [T(1), T(2), T(3), T(4), T(5)]);
freshRun();
const closedSeen = calls().length === 1 && fedNow().includes('〔dsh-4-答〕') && dshMarkOf(D1).mark === 5;
// 三、旧切法留下的水位（4 = [首条, 第1轮, 待办, 动过]）
//   C1：升级前多了一轮、而且待办被清空了 —— 旧切法下长度还是 4，但第 2 轮没看过，不能被越过；
//   C2：升级前没变过 —— 换算成 1，之后的新轮次照常读，旧的那轮不重送。
const C1 = path.join(DSH_D, 'session-old-a.json');
const C2 = path.join(DSH_D, 'session-old-b.json');
dshWrite(C1, [T('a1'), T('a2')], { todos: [] });
dshWrite(C2, [T('b1')]);
const mk = JSON.parse(fs.readFileSync(path.join(HOME_D, 'scribemark.json'), 'utf8'));
mk[C1] = 4; mk[C2] = 4;                                  // 旧版写下的水位，没有 #layout 标记
fs.writeFileSync(path.join(HOME_D, 'scribemark.json'), JSON.stringify(mk), 'utf8');
freshRun();                                              // 换算发生在这一轮：两个都换成 1，C1 的第 2 轮单独不足 200 字，先等着
const migC1 = dshMarkOf(C1); const migC2 = dshMarkOf(C2);
dshWrite(C1, [T('a1'), T('a2'), T('a3')], { todos: [] });
dshWrite(C2, [T('b1'), T('b2'), T('b3')]);
freshRun();
const fedMig = fedNow();
const migrated = migC1.mark === 1 && migC1.layout === 2 && migC2.mark === 1 && migC2.layout === 2
  && fedMig.includes('〔dsh-a2〕') && fedMig.includes('〔dsh-b2〕') && !fedMig.includes('〔dsh-a1〕') && !fedMig.includes('〔dsh-b1〕')
  && dshMarkOf(C1).mark === 3 && dshMarkOf(C2).mark === 3;
// 四、换算之后、存水位之前被杀：换算必须**先落盘**（Codex 第十轮复核：只在内存里换算时，暂存的 .tmp 是新坐标、
//   磁盘上还是旧水位，下次对账拿旧水位比新窗口 → 错误补发布，再重做一遍 → 同一段两条候选）
const C3 = path.join(DSH_D, 'session-old-c.json');
dshWrite(C3, [T('c1'), T('c2'), T('c3')], { todos: [] });
const mk3 = JSON.parse(fs.readFileSync(path.join(HOME_D, 'scribemark.json'), 'utf8'));
mk3[C3] = 3;                                             // 旧切法 [首条, 第1轮, 动过] 扫完是 3；换算成 0，三轮都要读
fs.writeFileSync(path.join(HOME_D, 'scribemark.json'), JSON.stringify(mk3), 'utf8');
const r29tKill = freshRun([], { AGENTMEM_FAILPOINT: 'scribe-after-stage' });
const killedMark = dshMarkOf(C3);
freshRun();
const pendD = path.join(HOME_D, 'pending');
const c1Cands = fs.readdirSync(pendD).filter((f) => f.endsWith('.json'))
  .filter((f) => JSON.parse(fs.readFileSync(path.join(pendD, f), 'utf8')).title.includes('〔dsh-c1〕')).length;
const killSafe = r29tKill.status === 86 && killedMark.layout === 2 && killedMark.mark === 0 && c1Cands === 1;
ok('29t dsh（真实尺寸）：短轮次攒够再送、没结束的一轮等结束、旧水位换算不漏、换算先落盘',
  grow && openSkipped && closedSeen && migrated && killSafe,
  `单轮不足 200 字先等着、攒够两轮一起送=${grow}；没结束的一轮先不算=${openSkipped}、结束后读到回答=${closedSeen}；`
  + `旧水位换算（待办清空的 ${migC1.mark}、没变过的 ${migC2.mark}，都应为 1），新轮次送了、旧轮次没重送=${migrated}；`
  + `暂存后被杀：退出码 ${r29tKill.status}、磁盘上已是新坐标=${killedMark.layout === 2 && killedMark.mark === 0}、恢复后这段的候选 ${c1Cands} 条（应为 1）`);

// ---- 29t2. 旧版留下的 dsh 暂存（没有坐标版本）：判断不了，原样隔离
// Codex 第十一轮复核用当时真实落盘的状态复现：f59455b 在内存里换算后暂存了新坐标的 .tmp、水位还是旧的；
// 按旧水位判成「已提交」补发布，换算后又重做 → 两条。旧版暂存分不出是哪套坐标，只能隔离。
// D1 的水位早越过了 [0,1]：哪一步没拦住，它就会被补发布出来。
const legacyTmp = path.join(pendD, `${crypto.randomUUID()}.json.tmp`);
const legacyBody = JSON.stringify({ id: 'legacy-dsh', agent: 'dsh', title: '旧版暂存', text: '没有坐标版本', sourceFile: D1, window: [0, 1] });
fs.writeFileSync(legacyTmp, legacyBody, 'utf8');
freshRun();
const legacyKept = fs.existsSync(`${legacyTmp}.corrupt`) && fs.readFileSync(`${legacyTmp}.corrupt`, 'utf8') === legacyBody
  && !fs.existsSync(legacyTmp) && !fs.existsSync(legacyTmp.slice(0, -'.tmp'.length));
ok('29t2 旧版 dsh 暂存（没有坐标版本）原样隔离，不补发布', legacyKept, `原样挪成 .corrupt、没有被补发布=${legacyKept}`);
fs.rmSync(HOME_D, { recursive: true, force: true });

// ---- 29y. `--init --agent claude` 读失败：别家的 dsh 旧水位也不能被换算落盘
// Codex 第十一轮复核：换算放在 --init 之前，init 读失败退出时 dsh 水位已经写了，「没有写任何水位」那句话是假的。
const HOME_Y = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmem-inity-'));
fs.mkdirSync(path.join(HOME_Y, 'ct'), { recursive: true });
fs.mkdirSync(path.join(HOME_Y, 'dsh'), { recursive: true });
fs.writeFileSync(path.join(HOME_Y, 'scribes.json'), JSON.stringify({
  claude: { model: 'stub', format: 'claude', transcripts: [path.join(HOME_Y, 'ct', '*.jsonl')], run: runOf('claude') },
  dsh: { model: 'stub', format: 'dsh', transcripts: [path.join(HOME_Y, 'dsh', '*.json')], run: ['node', STUB, 'dsh'] },
}, null, 2), 'utf8');
fs.writeFileSync(path.join(HOME_Y, 'ct', 'a.jsonl'), claudeTurn('init 读失败', ['Edit']), 'utf8');
const DY = path.join(HOME_Y, 'dsh', 'session-y.json');
dshWrite(DY, [T('y1'), T('y2')]);
const markY = path.join(HOME_Y, 'scribemark.json');
fs.writeFileSync(markY, JSON.stringify({ [DY]: 4 }), 'utf8');   // 旧版写下的 dsh 水位，没有 #layout
const markYBefore = fs.readFileSync(markY, 'utf8');
const r29y = spawnSync(process.execPath, [CLI, 'scribe', '--init', '--agent', 'claude'], {
  env: { ...autoEnv, AGENTMEM_HOME: HOME_Y, AGENTMEM_FAULT: 'init-read' }, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
});
const markYAfter = fs.readFileSync(markY, 'utf8');
ok('29y --init 读失败退出：水位表一个字节都没动（别家的 dsh 旧水位也没被换算）', r29y.status !== 0 && markYAfter === markYBefore,
  `退出码 ${r29y.status}（应非 0）；水位表没动=${markYAfter === markYBefore}`);
fs.rmSync(HOME_Y, { recursive: true, force: true });

// ---- 30. 同一个 id 的候选在 pending 里有两份，只能进库一次
// 两份同 id 的来源是真实的：旧逻辑下 scribe 被杀过、或者有人手动复制过 pending 里的文件。
fs.writeFileSync(MODE, 'accept', 'utf8');
const planted30 = plant('同一个 id 两份候选只能进库一次');
fs.copyFileSync(planted30, planted30.replace(/\.json$/, '-copy.json'));
const id30 = idOf(planted30);
const out30 = memo(['review']);
ok('30 同 id 两份候选只进库一次', idCount(id30) === 1 && countDir('pending') === 0,
  `这个 id 进库 ${idCount(id30)} 次（应为 1）；pending 剩 ${countDir('pending')}；`
  + `${(out30.match(/· [^\n]*清理[^\n]*/) || ['(第二份没被清理)'])[0].slice(0, 40)}`);

// ---- 31. 同一个 id 的两份，第一份被驳回、第二份遇到会判通过的审核 —— 只能有一个结局
// Codex 第三轮复核实测：原来 log 按 id 查、rejected 按文件名查，结果同一个 id 既通过又驳回。
fs.writeFileSync(MODE, 'reject-once', 'utf8');
gate.reset();
const planted31 = plant('同一个 id 不能既驳回又通过');
fs.copyFileSync(planted31, planted31.replace(/\.json$/, '-copy.json'));
const id31 = idOf(planted31);
memo(['review']);
ok('31 同 id 两份：驳回之后不能再通过', rejectedHas(id31) && idCount(id31) === 0 && countDir('pending') === 0,
  `已驳回=${rejectedHas(id31)}；进库 ${idCount(id31)} 次（应为 0）；pending 剩 ${countDir('pending')}`);

// ---- 32. 读不出来的候选挪成 .corrupt 留给人看，**内容原样保留**，也不挡住别的候选
const planted32 = plant('坏文件旁边的好候选照常审');
const id32 = idOf(planted32);
const bad32 = path.join(PEND, `${crypto.randomUUID()}.json`);
const badBody = '{"id": "写到一半就断了';
fs.writeFileSync(bad32, badBody, 'utf8');
fs.writeFileSync(MODE, 'accept', 'utf8');
memo(['review']);
const pend32 = memo(['pending']);
const kept32 = fs.existsSync(`${bad32}.corrupt`) && fs.readFileSync(`${bad32}.corrupt`, 'utf8') === badBody;
ok('32 坏候选原样隔离，不挡别的', kept32 && idCount(id32) === 1 && pend32.includes('坏文件'),
  `坏文件原样挪成 .corrupt=${kept32}；旁边的好候选进库 ${idCount(id32)} 次（应为 1）；memo pending 列出=${pend32.includes('坏文件')}`);

// ---- 33. 会话结束的 hook 在任何可捕获的故障下都以 0 退出
// Codex 第三轮复核实测：AGENTMEM_AGENT 超长 → 起后台 worker 时 spawn 同步抛 ENAMETOOLONG → hook 退出 1。
fs.rmSync(path.join(HOME, 'auto.log'), { force: true });
const r33 = spawnSync(process.execPath, [AUTO], {
  env: { ...autoEnv, AGENTMEM_AGENT: 'a'.repeat(32700) }, encoding: 'utf8', cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
});
ok('33 hook 起不了 worker 也以 0 退出', r33.status === 0 && /起不了后台 worker/.test(autoLog()),
  `退出码 ${r33.status}（应为 0）；auto.log 记下了原因=${/起不了后台 worker/.test(autoLog())}`);


console.log(`\n=== ${results.filter(r => r.pass).length}/${results.length} 通过 ===`);
console.log(`测试数据目录（未删，可查看）：${HOME}`);
process.exit(results.every(r => r.pass) ? 0 : 1);
