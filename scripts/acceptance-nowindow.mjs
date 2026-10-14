// 会话结束的 hook 不许弹窗、不许抢焦点。
//
// 背景（2026-10-08 用户报告，同日实测复现）：每次会话结束都弹出一个终端窗口并抢走焦点，
// 打断正在用的应用。codex 和 dsh 的 Stop 是**每一轮回复结束**都触发，所以是「每次都弹」。
//
// 机理：auto.mjs 用 `detached: true` 把 worker 甩到后台 —— Windows 上这等于 DETACHED_PROCESS，
// worker **没有控制台**。它再起 `node memo.mjs scribe/review` 时，子进程是控制台程序、
// 父进程又没控制台可继承，Windows 就**给子进程新建一个可见控制台**；Win11 上新控制台默认
// 交给 Windows Terminal，于是每一步弹一个 WT 窗口。实测一次会话结束弹 2 个、抢 2 次焦点。
//
// 这条闸测**症状本身**，不测「代码里有没有写 windowsHide」：
// 走真实 hook 入口（auto.mjs）→ 真实 detached worker → 真实子进程，
// 用 user32 枚举顶层窗口并盯前台窗口（scripts/winwatch.ps1），有新窗口或焦点被抢就红。
// 只查代码里的选项会漏掉「将来 worker 多起了一步」或「换了个起进程的写法」—— R13。
//
// 隔离：临时 AGENTMEM_HOME，transcript 指向空目录 → scribe 扫 0 个文件，**不调模型、不花钱**，
// 但 worker 照样会起那两个子进程，弹窗路径完整走到。
//
// ⚠️ 窗口是**全局**枚举的。第一版把「任何前台切换」都算失败，修好之后照样红了一次 ——
//    前台切到了 steamwebhelper，是别的应用自己抢的。所以前台切换只在「抢到焦点的是测试期间
//    新出现的窗口，或者是控制台宿主（WindowsTerminal/conhost/OpenConsole）」时才算嫌疑。
//    新窗口仍然一律算：测试那几秒里你自己新开了窗口，这条会误红，红了先看 proc= 再下结论。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') {
  console.log('SKIP  非 Windows：这个问题只在 Windows 的控制台模型下存在');
  process.exit(0);
}

const REPO = path.join(import.meta.dirname, '..');
const AUTO = path.join(REPO, 'bin', 'auto.mjs');
const WATCH = path.join(REPO, 'scripts', 'winwatch.ps1');
const REAL = path.join(os.homedir(), '.agentmem');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmem-nowin-'));
const EMPTY = path.join(HOME, 'no-transcripts');
fs.mkdirSync(EMPTY, { recursive: true });

// 复制真实配置的 run（里面的「不落盘」开关 assertNoPersist 会查），只把 transcript 指向空目录。
const scribes = JSON.parse(fs.readFileSync(path.join(REAL, 'scribes.json'), 'utf8'));
for (const spec of Object.values(scribes)) spec.transcripts = [path.join(EMPTY, '*.json*').replace(/\\/g, '/')];
fs.writeFileSync(path.join(HOME, 'scribes.json'), JSON.stringify(scribes, null, 2), 'utf8');
fs.writeFileSync(path.join(HOME, 'scribemark.json'), '{}', 'utf8');   // 有水位文件，auto 才肯跑

let out = '';
try {
  out = execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WATCH,
    '-Node', process.execPath, '-Script', AUTO, '-Agent', 'claude',
    '-Running', path.join(HOME, 'auto.running'), '-MaxSeconds', '90',
  ], {
    env: { ...process.env, AGENTMEM_HOME: HOME, AGENTMEM_MODEL_CACHE: path.join(REAL, 'model-cache') },
    encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  out = String(e.stdout || '') + String(e.stderr || '');
}
console.log(out.trim().split('\n').map((l) => `      ${l.trim()}`).join('\n'));

const m = out.match(/RESULT\s+sawWorker=(\w+)\s+newWindows=(\d+)\s+suspectForeground=(\d+)/);
const log = fs.existsSync(path.join(HOME, 'auto.log')) ? fs.readFileSync(path.join(HOME, 'auto.log'), 'utf8') : '';
// 两步都**真的跑成了**才算数：子进程根本没起来（ENOENT 之类）也是零窗口，那是假绿。
const ranScribe = /\[scribe\] \d+s\n/.test(log);
const ranReview = /\[review\] \d+s\n/.test(log);

const pass = !!m && m[1] === 'True' && m[2] === '0' && m[3] === '0' && ranScribe && ranReview;
console.log(`${pass ? 'PASS' : 'FAIL'}  会话结束 hook 不弹窗、不抢焦点`);
console.log(`      worker 真的跑过=${m ? m[1] : '?'} · 新窗口 ${m ? m[2] : '?'} 个 · 焦点被抢 ${m ? m[3] : '?'} 次`
  + ` · scribe 跑成=${ranScribe} · review 跑成=${ranReview}（标 * 的才算我们抢的焦点）`);
if (!ranScribe || !ranReview) console.log(`      auto.log:\n${log.split('\n').map((l) => `        ${l}`).join('\n')}`);

fs.rmSync(HOME, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
