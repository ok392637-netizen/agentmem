// ============================================================================
// 操作系统级互斥锁：Windows 命名管道 / Linux 抽象命名空间 socket。
//
// 为什么不用「锁文件/锁目录 + 看时间判断持有者死没死」：那需要过期、接管、心跳，三样一起就是
// 一串竞态。2026-10-08 两轮 Codex 对抗式复核逐条找出、并在临时库里注入时序复现：
//   · N 个进程在任何一个刷新之前都读到旧时间 → N 个一起接管，没有上界
//     （验收第 19 条在旧代码上实测：5 个 worker 撞上陈旧锁，5 个全跑了）；
//   · 递归 mkdir 对已存在的目录也返回成功 → 选不出唯一赢家；
//   · 锁不记主人 → 旧进程退出时把新进程的锁删掉；
//   · 活着但跑得久、或者整机睡过的进程会被当成死的。
// 同一时期 review 的「认领」也是同一个病：我先后补了认领名后缀、所有权检查、mtime 刷新，
// 每补一层都还剩一个更窄的窗口，第二轮复核照样注入打穿。病根是**让并发的进程去协商**；
// 治法是**不让它们并发**。
//
// 命名管道把「判死活」交给操作系统：同名管道同一时刻只能有一个进程在监听，进程一死
// （哪怕被直接 TerminateProcess、退出处理一行都没跑）系统立刻收回。G0 实测（本机，Node 24）：
//   持有期间 5 个进程同时抢 → 5 个全是 EADDRINUSE；持有者被强杀 → 3ms 后可拿；
//   5 个进程同时抢一个空闲名字 → 恰好 1 个赢（跑两次都是）。
//
// ⚠️ Linux 走抽象命名空间（`\0` 开头，进程死了同样自动释放）—— **本机没验证过**。
//    macOS 没有抽象命名空间，listen 会报错 → 返回 error → 调用方拒绝运行（宁可不跑，不可并发）。
// ============================================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// 同一个库必须只对应一个锁名。8.3 短路径、junction、`\\?\` 前缀、大小写、斜杠方向，
// 都会让 path.resolve 得到不同的串，于是两把锁并存、互斥失效（Codex 第二轮复核实测）。
// realpath.native 走 GetFinalPathNameByHandle，返回规范长路径，这些写法都归一。
function canonical(dir) {
  try { return fs.realpathSync.native(dir).toLowerCase(); } catch { return path.resolve(dir).toLowerCase(); }
}

// 拿锁。锁一直持有到进程结束（由操作系统释放），没有「主动释放」—— 用它的都是短命进程，
// 而「忘了释放」和「释放早了」正是要避免的两类错。
// 返回 { ok: true } / { ok: false, busy: true }（别人拿着）/ { ok: false, error }（锁机制本身不可用）。
// 调用方对 error 必须**拒绝运行**：拿不到锁就跑，等于没有锁。
export function holdLock(dir, purpose) {
  const name = `agentmem-${purpose}-${crypto.createHash('sha1').update(canonical(dir)).digest('hex').slice(0, 12)}`;
  const where = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `\0${name}`;
  return new Promise((resolve) => {
    try {
      const srv = net.createServer();
      srv.on('error', (e) => resolve(e && e.code === 'EADDRINUSE' ? { ok: false, busy: true } : { ok: false, error: e }));
      // unref：监听着的管道不该让进程在活干完后还挂着不退；它照样一直占着名字，直到进程结束。
      srv.listen(where, () => { srv.unref(); resolve({ ok: true }); });
    } catch (e) {
      // listen 同步抛异常（平台不支持这种地址之类）也走 error，绝不往外抛 ——
      // auto.mjs 的 hook 不能因为这个非零退出。
      resolve({ ok: false, error: e });
    }
  });
}
