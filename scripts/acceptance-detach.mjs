// 闸：hook 拉起的 worker 要能活过宿主退出。
//
// 2026-10-09 实测：codex 的 Stop hook 拉起的 worker 会被一起强杀 —— 自动记忆约 17 小时一次都没跑完，
// auto.log 里只剩一串开头行，没有任何报错。
// 这条闸不依赖 codex：scripts/jobhost.ps1 自己造一个带 KILL_ON_JOB_CLOSE 的 Job，把自己放进去，
// 在里面调用 hook（bin/auto.mjs），然后退出 —— Job 里所有进程跟着被杀。
// （这只复现了「一种」能杀进程的机制；codex 0.162 的实际做法是 hook 超时才终止整个 Job，见 bin/auto.mjs 的说明。
//  按会话、按全局扫描、按明确 PID 去杀，WMI 起的 worker 也活不了，这条闸不覆盖。）
//
// 断言缺一条就是假绿：
//   · 对照组：同一个宿主里用普通 detached 起的进程**必须被杀** —— 否则这个宿主根本没复现问题，闸是空的；
//   · 实验组用**屏障**：桩模型一直等一个放行文件。宿主退出之后，先确认 worker 已经进到模型调用、还没做完、进程还活着，
//     再放行，最后确认它跑完。上一版只看「最后跑完了」：Codex 第十一轮复核把 WMI 换回普通 detached、让 hook 拖 20 秒，
//     15 秒的桩在宿主退出前就跑完了，照样全绿。
//   · 环境要交到：worker 写的是临时库（AGENTMEM_HOME 传到了）；环境没交到时 worker 必须不跑、在 --home 的库里报出来。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') { console.log('SKIP  只在 Windows 上有意义'); process.exit(0); }

const REPO = path.resolve(import.meta.dirname, '..');
const HOST = path.join(REPO, 'scripts', 'jobhost.ps1');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmem-detach-'));
const results = [];
const ok = (n, pass, detail) => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}\n      ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await sleep(250); return cond(); };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// 模型缓存用临时目录：这条闸里不会加载模型，万一加载了也不该碰真实的缓存
const runHost = (script, extra = []) => spawnSync('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HOST, '-Node', process.execPath, '-Script', script, '-Wait', '2', ...extra], {
    env: { ...process.env, AGENTMEM_HOME: HOME, AGENTMEM_MODEL_CACHE: path.join(HOME, 'model-cache') },
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  });

// ---- 对照组：普通 detached 子进程（auto.mjs 原来的起法）必须被宿主连带杀掉
const BEAT = path.join(HOME, 'plain-beat.log');
const SPAWNER = path.join(HOME, 'plain-spawner.mjs');
fs.writeFileSync(SPAWNER, `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
if (process.argv[2] === 'child') {
  const t = Date.now(); const nap = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() - t < 15000) { fs.appendFileSync(${JSON.stringify(BEAT)}, 'beat\\n'); Atomics.wait(nap, 0, 0, 500); }
  fs.appendFileSync(${JSON.stringify(BEAT)}, 'done\\n');
} else {
  spawn(process.execPath, [process.argv[1], 'child'], { detached: true, stdio: 'ignore' }).unref();
}
`, 'utf8');
const hostPlain = runHost(SPAWNER);
await sleep(17000);                                          // 子进程不被杀的话 15 秒后会写 done
const plainKilled = read(BEAT).includes('beat') && !read(BEAT).includes('done');
ok('对照：kill-on-close 宿主确实会杀掉普通 detached 子进程', hostPlain.status === 0 && plainKilled,
  `宿主退出码 ${hostPlain.status}；子进程起来过=${read(BEAT).includes('beat')}、被杀（没写到 done）=${!read(BEAT).includes('done')}`
  + `${hostPlain.status !== 0 ? `；宿主输出：${String(hostPlain.stdout + hostPlain.stderr).trim().slice(0, 200)}` : ''}`);

// ---- 实验组：auto.mjs 起的 worker 要活过宿主
// 临时库：一段有写操作的会话 + 一个停在屏障上的桩模型，worker 跑 scribe 时一定会叫到它
const CT = path.join(HOME, 'ct');
fs.mkdirSync(CT, { recursive: true });
const STUB_LOG = path.join(HOME, 'stub.log');
const RELEASE = path.join(HOME, 'release');
const STUB = path.join(HOME, 'gated-stub.cjs');
fs.writeFileSync(STUB, `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(STUB_LOG)}, 'start\\n');
const t = Date.now(); const nap = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(${JSON.stringify(RELEASE)}) && Date.now() - t < 120000) Atomics.wait(nap, 0, 0, 200);
fs.appendFileSync(${JSON.stringify(STUB_LOG)}, fs.existsSync(${JSON.stringify(RELEASE)}) ? 'end\\n' : 'gate-timeout\\n');
process.stdout.write(JSON.stringify({ worth: false, type: '', title: '', text: '', quotes: [] }) + '\\n');
`, 'utf8');
fs.writeFileSync(path.join(HOME, 'scribes.json'), JSON.stringify({
  // 「不落盘」「不许用工具」的参数桩都不认，但 scribe 会拒绝跑缺了它们的配置（和真实配置同构）
  claude: { model: 'stub', format: 'claude', transcripts: [path.join(CT, '*.jsonl')],
    run: ['node', STUB, '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--permission-mode', 'dontAsk'] },
}, null, 2), 'utf8');
fs.writeFileSync(path.join(HOME, 'scribemark.json'), '{}', 'utf8');   // 有水位表，auto 才肯跑
const filler = '我先复现了一下，然后逐个排查了调用链上的几个位置，确认问题不在参数解析那一层。'.repeat(8);
fs.writeFileSync(path.join(CT, 'probe.jsonl'), `${[
  JSON.stringify({ type: 'user', message: { role: 'user', content: '探针：hook 拉起的 worker 能不能活过宿主退出' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: filler }, { type: 'tool_use', name: 'Edit', input: {} }] } }),
].join('\n')}\n`, 'utf8');

const host = runHost(path.join(REPO, 'bin', 'auto.mjs'), ['-Agent', 'detachprobe']);
// 宿主已经退出（runHost 是同步的）。屏障：worker 进到模型调用了、没做完、还活着
const entered = await waitFor(() => read(STUB_LOG).includes('start'), 30000);
const running = (() => { try { return JSON.parse(read(path.join(HOME, 'auto.running'))).pid; } catch { return null; } })();
const aliveAfterHost = entered && !read(STUB_LOG).includes('end') && running !== null && alive(running);
fs.writeFileSync(RELEASE, '');
const LOG = path.join(HOME, 'auto.log');
const finished = await waitFor(() => /\[review\]/.test(read(LOG)), 60000);
const log = read(LOG);
const header = (log.match(/=====[^\n]*触发[^\n]*/) || [''])[0];
ok('宿主死后 worker 还活着、停在模型调用里；放行之后跑完 scribe 和 review',
  host.status === 0 && aliveAfterHost && finished && /\[scribe\] \d+s/.test(log) && read(STUB_LOG).includes('end')
  && !fs.existsSync(path.join(HOME, 'auto.running')),
  `宿主退出码 ${host.status}；宿主退出后：worker 进了模型调用=${entered}、还没做完且进程活着=${aliveAfterHost}；`
  + `放行后跑完=${finished}、桩正常结束=${read(STUB_LOG).includes('end')}、auto.running 清掉=${!fs.existsSync(path.join(HOME, 'auto.running'))}`);
ok('worker 经 WMI 起、拿到了宿主的环境变量', /detachprobe 触发，经 wmi 起/.test(header) && /\[scribe\]/.test(log),
  `开头行：${header || '（没有）'}；日志写进了临时库（说明 AGENTMEM_HOME 传到了）=${/\[scribe\]/.test(log)}`);
const leftovers = fs.existsSync(path.join(os.tmpdir(), 'agentmem-launch'));
ok('不再有落盘的环境交接文件', !leftovers, `%TEMP%\\agentmem-launch 存在=${leftovers}（应为 false：环境直接经 WMI 交过去）`);

// ---- 环境没交到：worker 不跑，在 --home 指的库里记一笔，不去碰默认的库
// Codex 第十一轮复核：worker 拿不到环境时用 WMI 给的默认环境接着跑 —— 少了 AGENTMEM_HOME 就写进另一个库。
// 直接起 worker（不经 WMI），带上 --token 却不在环境里放令牌 = 「环境没交到」；
// 把用户目录指到一个临时目录，这样「默认的库」也是临时的、看得见有没有被碰。
const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmem-envlost-'));
const FAKE_PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmem-profile-'));
const env2 = { ...process.env, USERPROFILE: FAKE_PROFILE, HOME: FAKE_PROFILE };
delete env2.AGENTMEM_HOME;
delete env2.AGENTMEM_LAUNCH_TOKEN;
const r2 = spawnSync(process.execPath, [path.join(REPO, 'bin', 'auto.mjs'), '--worker', '--agent', 'envlost', '--via', 'wmi',
  '--home', HOME2, '--token', 'not-delivered'], { env: env2, encoding: 'utf8', windowsHide: true, timeout: 60000 });
const log2 = read(path.join(HOME2, 'auto.log'));
const defaultTouched = fs.existsSync(path.join(FAKE_PROFILE, '.agentmem'));
ok('环境没交到：worker 不跑、在指定的库里报出来、不碰默认的库',
  r2.status === 0 && /环境变量没收到/.test(log2) && !/\[scribe\]/.test(log2) && !defaultTouched,
  `退出码 ${r2.status}；指定的库里报出=${/环境变量没收到/.test(log2)}；没跑 scribe=${!/\[scribe\]/.test(log2)}；`
  + `默认的库被碰了=${defaultTouched}（应为 false）`);
fs.rmSync(HOME2, { recursive: true, force: true });
fs.rmSync(FAKE_PROFILE, { recursive: true, force: true });

console.log(`\n=== ${results.filter(Boolean).length}/${results.length} 通过 ===`);
if (results.every(Boolean)) fs.rmSync(HOME, { recursive: true, force: true });
else console.log(`测试数据目录（未删）：${HOME}`);
process.exit(results.every(Boolean) ? 0 : 1);
