#!/usr/bin/env node
// ============================================================================
// 自动记忆的触发入口：扫一遍 → 审一遍。挂在 claude 的 SessionEnd 上，后台跑。
//
// **一个 hook 就够覆盖两个 agent。**
// scribe 是从磁盘读 transcript 的，不需要跑在被扫的那个 agent 进程里 ——
// 所以 codex 的 hooks.json 一个字都不用改（那文件被 oh-my-codex 占着，
// config.toml 里还有 trusted_hash 校验，动它风险不对等）。
// 代价：codex 的会话要等下一次 claude 会话结束才被扫到。可以接受，因为
// transcript 是 append-only 的，晚扫不会丢，水位会补上。
//
// 输出全部落 ~/.agentmem/auto.log：hook 的 stdout 不会有人看，
// 而「闸挡掉了什么」只能靠日志回答。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { holdLock } from '../lib/oslock.mjs';

const argOf = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

// ---- worker 的环境变量是启动方经 WMI 直接交过来的（见下面「脱离父进程」），这里核对**交到了没有**：
// 启动方生成一个随机令牌，同时放进交过去的环境（AGENTMEM_LAUNCH_TOKEN）和命令行（--token）。
// 两边对不上 = 环境没交到，worker 拿的是 WMI 给的默认环境 —— 少了代理叫模型会失败，少了 AGENTMEM_HOME 会写错库
// （Codex 第十一轮复核）→ 不跑（见下面 ENV_LOST）。不经 WMI 起的 worker 没有 --token，环境是直接继承的，不用核对。
const TOKEN = argOf('--token');
const ENV_LOST = TOKEN !== undefined && process.env.AGENTMEM_LAUNCH_TOKEN !== TOKEN;
delete process.env.AGENTMEM_LAUNCH_TOKEN;   // 不再往 scribe/review 的子进程里传

// 库的位置启动方也在命令行里给一份（--home，不是秘密）：环境没交到时，worker 仍然知道该往哪个库的日志里报错。
const ROOT = argOf('--home') || process.env.AGENTMEM_HOME || path.join(os.homedir(), '.agentmem');
const CLI = path.join(import.meta.dirname, 'memo.mjs');
const LOG = path.join(ROOT, 'auto.log');

// 身份走参数：hooks.json 只能写命令字符串，设不了环境变量。
// scribe/review 的归属其实来自 scribes.json，这里只是满足 CLI 的「必须有身份」检查，
// 但写对了日志才看得出是谁触发的。
const AGENT = argOf('--agent') || process.env.AGENTMEM_AGENT || 'claude';

// 这两样都不许抛：hook 进程在下面「脱离父进程」之前就会执行到这里，
// 抛出去就是 hook 非零退出 —— 记忆系统不该能弄坏会话收尾（Codex 复核指出的旧缺口）。
try { fs.mkdirSync(ROOT, { recursive: true }); } catch { /* 建不了目录，日志写不进去就算了 */ }
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (s) => {
  try { fs.appendFileSync(LOG, s.endsWith('\n') ? s : `${s}\n`, 'utf8'); } catch { /* 同上 */ }
};

// ---- 脱离父进程
// 不用 cmd 的 `start /b`：实测从 hook 那条调用链里它根本没把进程起起来，而且不报错。
//
// **Windows 上经 WMI 起 worker**（Win32_Process.Create：新进程的父进程是 WMI 服务，不在调用方的进程树和 Job 里，
// 也不继承调用方的任何句柄）。原来是 spawn(detached)，2026-10-09 实测：codex 的 Stop hook 拉起的 worker 被一起强杀
// （探针：worker 和它叫的模型进程都没了，auto.running 残留）。10-08 16:47 起 auto.log 里一连串只有开头一行的记录
// 都是这么死的 —— 那段时间的触发全来自 codex exec，自动记忆约 17 小时一次都没跑完，没有任何报错。
// 机制（Codex 第十一轮复核读 0.162 的 hooks/command_runner.rs）：codex 在 Job 里跑 hook，**等 hook 的输出关闭**，
// 正常结束就留着子孙进程；超时（30 秒）才终止整个 Job。旧版 hook 实测约 32 秒、以超时结束 —— 推测是 detached 的
// worker 继承了 hook 的输出管道、管道一直不关（这一步是推测）。WMI 起的 worker 不继承句柄，hook 3.5 秒正常结束。
// claude 的 SessionEnd 不这样杀（同一探针，worker 跑完了）。
// 这个修法的闸：scripts/acceptance-detach.mjs（自己造一个 kill-on-close 的 Job 宿主，屏障保证「宿主死时 worker 还没做完」）。
//
// WMI 起的进程**不继承调用方的环境变量**（实测：代理 HTTPS_PROXY 只在 hook 继承来的环境里、注册表里没有，
// 丢了它 worker 叫模型就连不上）。环境经 Win32_ProcessStartup.EnvironmentVariables 直接交过去
// （CreateFlags 0x400 = Unicode 环境，中文、空格、引号都能原样过去 —— Codex 第十一轮复核验证过）。
// 上一版是写进 %TEMP% 下的临时文件、worker 读完即删：临时目录的权限不可控，
// 文件里却是含 API key 的完整环境，失败路径还会残留。现在不落盘。也不放命令行：命令行同一用户的任何进程都看得到。
// 环境交给 PowerShell 用的是它自己的环境变量（AGENTMEM_LAUNCH_ENV），和 hook 本来就有的环境同一个暴露面。
//
// 另一个只在 WMI 起的进程里才会遇到的坑：Claude 桌面应用是 MSIX 打包的，在它里面装进 %APPDATA% 的东西
// （npm 全局命令）WMI 起的进程看不到 —— 2026-10-09 codex.cmd 就是这样找不到的。那是环境问题，不在这里修。
// WMI 起不来就退回原来的 spawn —— claude 触发的照样能跑，只是 codex 触发的会被杀；退回时 auto.log 记一笔。
const PS_CREATE = '$vars = [string[]](ConvertFrom-Json $env:AGENTMEM_LAUNCH_ENV); '
  + '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly '
  + '-Property @{ShowWindow=[uint16]0; CreateFlags=[uint32]1024; EnvironmentVariables=$vars}; '
  + '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create '
  + '-Arguments @{CommandLine=$env:AGENTMEM_LAUNCH_CMD; ProcessStartupInformation=$si}; '
  + 'Write-Output ("rv=" + $r.ReturnValue)';
// Windows 命令行的引号规则（CommandLineToArgvW）：引号前的反斜杠加倍、引号转义，末尾的反斜杠加倍
const quoteArg = (a) => (a && !/[\s"]/.test(a) ? a
  : `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);

// 起来了返回 null；没起来返回原因（调用方退回 spawn）；不知道起没起来返回 { unsure: 原因 }。
function launchViaWmi(args) {
  // 上一版留下的交接文件（含完整环境变量）：不管还剩没剩，删掉
  // 删不掉要说出来（force 下目录不存在不会抛，抛了就是真删不掉）—— 里面可能是含 API key 的环境变量（Codex 第十六轮复核）
  try { fs.rmSync(path.join(os.tmpdir(), 'agentmem-launch'), { recursive: true, force: true }); } catch (e) {
    log(`\n===== ${stamp()} =====\n[注意] 删不掉旧版留下的 ${path.join(os.tmpdir(), 'agentmem-launch')}（${e.code || e.message}）：`
      + '里面可能是含 API key 的环境变量文件，请手动删除');
  }
  try {
    const token = crypto.randomUUID();
    const vars = Object.entries({ ...process.env, AGENTMEM_LAUNCH_TOKEN: token }).map(([k, v]) => `${k}=${v}`);
    const cmd = [process.execPath, import.meta.filename, ...args, '--token', token].map(quoteArg).join(' ');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_CREATE], {
      env: { ...process.env, AGENTMEM_LAUNCH_CMD: cmd, AGENTMEM_LAUNCH_ENV: JSON.stringify(vars) },
      encoding: 'utf8', windowsHide: true, timeout: 20000,
    });
    const rv = (String(r.stdout || '').match(/rv=(\d+)/) || [])[1];
    if (rv === '0') return null;
    // 不知道起没起来：不退回 spawn（可能起两个，auto 锁会让第二个让路，但没必要）
    if (r.error && r.error.code === 'ETIMEDOUT') return { unsure: 'WMI 启动超时，不确定 worker 起没起来' };
    const detail = rv !== undefined ? `返回值 ${rv}`
      : String((r.error && r.error.message) || r.stderr || '无输出').trim().split('\n')[0].slice(0, 80);
    return `WMI 没起来（${detail}）`;
  } catch (e) {
    return `WMI 没起来（${String(e && e.message).split('\n')[0].slice(0, 80)}）`;
  }
}

if (!process.argv.includes('--worker')) {
  // 把 --agent 一起传下去：不传的话 worker 丢身份，日志看不出是谁触发的。
  // spawn 会**同步抛**（Codex 第三轮复核实测：AGENTMEM_AGENT 超长 → ENAMETOOLONG → hook 退出 1）。
  // hook 非零退出就是记忆系统弄坏了会话收尾，所以包起来：起不来就记一笔、照样退出 0。
  const args = ['--worker', '--agent', AGENT];
  const why = process.platform === 'win32' ? launchViaWmi([...args, '--via', 'wmi', '--home', ROOT]) : '不是 Windows';
  if (why && why.unsure) {
    log(`\n===== ${stamp()} =====\n[注意] ${why.unsure}`);
  } else if (why) {
    try {
      const child = spawn(process.execPath, [import.meta.filename, ...args, '--via', 'spawn'], {
        detached: true, stdio: 'ignore', env: process.env,
      });
      child.on('error', () => { /* 异步的启动失败：进程马上就退了，没人接得住，别让它变成未处理异常 */ });
      child.unref();
      if (process.platform === 'win32') log(`\n===== ${stamp()} =====\n[注意] ${why}，改用普通方式起 worker（宿主退出时可能被一起杀掉）`);
    } catch (e) {
      log(`\n===== ${stamp()} =====\n[跳过] 起不了后台 worker：${String(e && e.message).split('\n')[0].slice(0, 120)}（之前：${why}）`);
    }
  }
  process.exit(0);
}

// ---- 启动方交来的环境没交到：不跑（见文件开头）。日志写进 --home 指的那个库，不是默认的。
if (ENV_LOST) {
  log(`\n===== ${stamp()} =====\n[跳过] 启动方交来的环境变量没收到（令牌对不上），这次不跑 —— `
    + '用默认环境跑的话，少了代理叫模型会失败，少了 AGENTMEM_HOME 会写错库。');
  process.exit(0);
}

// ---- 安全联锁：没跑过 --init 就不许扫
// 水位文件不存在 = 所有 transcript 的水位都是 0 = 会把全部历史会话重扫一遍。
// 光一个会话就上万行，那是几百次模型调用。这个错我自己差点犯，所以做成硬拦截而不是文档里的一句话。
if (!fs.existsSync(path.join(ROOT, 'scribemark.json'))) {
  log(`\n===== ${stamp()} =====\n[跳过] 还没建水位。先跑一次 `
    + `memo scribe --init，否则会回溯全部历史会话。`);
  process.exit(0);
}

// ---- 进程锁（实现和「为什么不用锁文件」见 lib/oslock.mjs）
//
// 为什么要锁：两个 worker 并跑会把同一批窗口各算一遍、白烧一倍额度。
// 触发比看起来频繁得多：codex/dsh 的 Stop 每轮回复都触发；scribe/review 自己调
// `codex exec` / `claude -p` 时，**还会触发它们自己的 Stop/SessionEnd hook，又调一次本脚本**
// （2026-10-08 在临时库里实测到：一次 review 引出两次额外触发）。auto.log 里见过 1 秒内 5 次。
// 原来的目录锁接管陈旧锁时连时间都不刷新：09-25 15:21 UTC 起 3 分钟里
// 「抢占了 1592→1596 分钟前的陈旧锁」连续十几次、十几个 worker 并发，那时还没修弹窗，
// 等于同时弹出几十个窗口。
// 这把锁只防 worker 重复；scribe 和 review 各自还会拿一把 writer 锁（见 lib/scribe.mjs），
// 防的是手动跑的 `memo review` 和后台的撞车。
const lock = await holdLock(ROOT, 'auto');
if (!lock.ok) {
  log(`\n===== ${stamp()} =====\n[跳过] ${lock.busy
    ? '已有一个 auto 在跑（锁被占用）。'
    : `拿不到进程锁（${String((lock.error && (lock.error.code || lock.error.message)) || '?')}）—— 宁可这次不跑，也不能不加锁地跑。`}`);
  process.exit(0);
}

// 「正在跑」标记：只给人和测试看（scripts/winwatch.ps1 靠它判断 worker 跑完没有），
// **不参与互斥**。进程被强杀时它会留下，下一个 worker 覆盖它就行，留着也不挡任何人。
const RUNNING = path.join(ROOT, 'auto.running');
try { fs.writeFileSync(RUNNING, JSON.stringify({ pid: process.pid, since: new Date().toISOString() })); } catch { /* 只是标记 */ }
process.on('exit', () => { try { fs.rmSync(RUNNING, { force: true }); } catch { /* 同上 */ } });

// 每一步最长跑多久，到点子进程被杀，worker 接着走下一步。
const STEP_TIMEOUT_MS = 30 * 60 * 1000;

// 开头一行带上触发方和起法：10-09 那批「只有开头一行」的记录，事后只能靠时间去对是谁触发的。
const VIA = argOf('--via') || '?';
log(`\n===== ${stamp()} =====  ${AGENT.slice(0, 40)} 触发，经 ${VIA} 起`);
for (const step of ['scribe', 'review']) {
  const t0 = Date.now();
  try {
    // spawnSync 而不是 execFileSync：后者成功时**只给 stdout**，stderr 直接丢掉。
    // 而 scribe/review 把「模型调用失败」「审核者不可用」都写在 stderr、步骤本身照样退出 0 ——
    // 于是 claude CLI 掉了登录之后，auto.log 只写「调模型 1 次、新候选 0 条」，
    // 跟「没东西可记」一模一样，失败是绿色的（2026-10-08 发现）。
    const r = spawnSync(process.execPath, [CLI, step], {
      // 身份对 scribe/review 无关紧要（归属来自 scribes.json），但 CLI 要求必须有。
      env: { ...process.env, AGENTMEM_AGENT: AGENT },
      encoding: 'utf8',
      timeout: STEP_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      // ⚠️ 必须有。上面 detached 起的 worker 在 Windows 上是 DETACHED_PROCESS ——
      //    **没有控制台**。它起的子进程是控制台程序、又无控制台可继承，Windows 就新建一个
      //    **可见的**；Win11 默认交给 Windows Terminal → 每一步弹一个窗口并抢走焦点。
      //    实测（2026-10-08，用户报告「每次对话结束弹窗打断其他应用」）：一次会话结束
      //    弹 2 个、抢 2 次焦点，而 codex/dsh 的 Stop 每轮回复都触发。
      //    windowsHide + stdio 全走管道 → libuv 给 CREATE_NO_WINDOW：子进程有控制台但没窗口，
      //    它再往下起的 claude/codex/dsh 都继承这个隐藏控制台，所以只需要在这一层设。
      //    闸：scripts/acceptance-nowindow.mjs（枚举真实窗口，不查这行代码在不在）。
      windowsHide: true,
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    const out = String(r.stdout || '').trim();
    const err = String(r.stderr || '').trim();
    if (r.error || r.status !== 0) {
      // 退出码和信号一起记：09-25 那批 `[review] 失败` 只有一句 Command failed、输出全空，
      // 事后只能靠「全空」去猜它是被外部杀掉的。有了退出码就不用猜。
      // error 和 status/signal 不是二选一：超时时 error=ETIMEDOUT **同时** signal=SIGTERM，两样都要。
      const why = [
        r.error && String(r.error.message).split('\n')[0],
        `退出码 ${r.status}${r.signal ? `，信号 ${r.signal}` : ''}`,
      ].filter(Boolean).join('；');
      log(`[${step}] 失败 ${secs}s: ${why}\n${out}\n${err}`);
    } else {
      log(`[${step}] ${secs}s\n${out}${err ? `\n${err}` : ''}`);
    }
  } catch (e) {
    // 一步失败不拖累另一步，也绝不让 hook 非零退出 —— 记忆系统不该能弄坏会话收尾。
    log(`[${step}] 失败 ${Math.round((Date.now() - t0) / 1000)}s: ${String(e && e.message).split('\n')[0]}`);
  }
}

// 日志超过 1MB 就截掉前半，避免无人看管地长成几百兆。
try {
  const st = fs.statSync(LOG);
  if (st.size > 1024 * 1024) {
    const keep = fs.readFileSync(LOG, 'utf8').slice(-512 * 1024);
    fs.writeFileSync(LOG, `（旧日志已截断）\n${keep}`, 'utf8');
  }
} catch { /* 截不了就算了，不值得为此失败 */ }
