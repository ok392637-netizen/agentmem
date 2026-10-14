// ============================================================================
// 给 ~/.codex/hooks.json 里的条目算出 codex 要的 trusted_hash，写进 config.toml。
//
// 为什么需要：codex 只跑**白名单里**的 hook —— config.toml 里有
//   [hooks.state.'<hooks.json路径>:<event>:<组>:<序号>']  trusted_hash = "sha256:…"
// 没有对应条目的 hook 被**静默跳过，不报错**（2026-09-20 实测，为此绕了很久）。
// 交互式 codex 才弹信任提示，而 `--dangerously-bypass-hook-trust` 只对 `codex exec` 有效，
// 交互式会话传不了参数 —— 所以自动化接线必须自己把信任写进去。
//
// 算法从 oh-my-codex 的 dist/config/codex-hooks.js 反推：
//   identity = { event_name, [matcher], hooks:[{type,command,timeout,async:false,[statusMessage]}] }
//   hash     = "sha256:" + sha256(JSON.stringify(键名递归排序后的 identity))
//   timeout  = max(1, hook.timeout ?? 600)
//
// **先跑 --verify**：它拿这套算法重算 oh-my-codex 已有的那几条 hash 去对照。
// 对不上就说明算法猜错了，这时候绝不能写 —— 写进去的是废条目，而 hook 照样静默不跑。
//
//   node scripts/codex-hook-trust.mjs --verify   # 只对照，不改文件
//   node scripts/codex-hook-trust.mjs --write    # 补缺失的（已有的不动，先备份）
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const LABEL = {
  SessionStart: 'session_start',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  UserPromptSubmit: 'user_prompt_submit',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  Stop: 'stop',
};

const isPlain = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const canonical = (v) => (Array.isArray(v)
  ? v.map(canonical)
  : isPlain(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
    : v);

function hookHash(eventName, entry, hook) {
  const identity = {
    event_name: LABEL[eventName],
    ...(entry.matcher ? { matcher: entry.matcher } : {}),
    hooks: [{
      type: 'command',
      command: hook.command,
      timeout: Math.max(1, hook.timeout ?? 600),
      async: false,
      ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
    }],
  };
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex')}`;
}

const HOOKS = path.join(os.homedir(), '.codex', 'hooks.json');
const CONF = path.join(os.homedir(), '.codex', 'config.toml');
const cfgText = fs.readFileSync(CONF, 'utf8');
const cfgLines = cfgText.split('\n');

// 不用正则查 config.toml —— 路径里全是反斜杠，转义层数太容易出错。
// 逐行扫：看到 [hooks.state.'<key>'] 就把下一行的 trusted_hash 取出来。
function existingHash(key) {
  const a = `[hooks.state.'${key}']`;
  const b = `[hooks.state."${key}"]`;
  for (let i = 0; i < cfgLines.length; i++) {
    const line = cfgLines[i].trim();
    if (line !== a && line !== b) continue;
    for (let j = i + 1; j < Math.min(i + 4, cfgLines.length); j++) {
      const m = cfgLines[j].trim();
      if (m.startsWith('trusted_hash')) {
        const q = m.indexOf('"');
        return q >= 0 ? m.slice(q + 1, m.indexOf('"', q + 1)) : null;
      }
      if (m.startsWith('[')) break;
    }
  }
  return null;
}

const hooks = JSON.parse(fs.readFileSync(HOOKS, 'utf8')).hooks || {};
const rows = [];
for (const [ev, groups] of Object.entries(hooks)) {
  if (!LABEL[ev]) { console.log(`  （跳过未知事件 ${ev}）`); continue; }
  groups.forEach((entry, gi) => (entry.hooks || []).forEach((h, hi) => {
    if (h.type !== 'command') return;
    const key = `${HOOKS}:${LABEL[ev]}:${gi}:${hi}`;
    rows.push({ key, ev, gi, hi, cmd: h.command, want: hookHash(ev, entry, h), have: existingHash(key) });
  }));
}

if (process.argv.includes('--write')) {
  const bad = rows.filter((r) => r.have && r.have !== r.want);
  if (bad.length) {
    console.error(`拒绝写入：有 ${bad.length} 条已存在的 hash 与算出来的对不上，说明算法不对。`);
    console.error('算错了还写进去的话，hook 会继续静默不跑，而看起来像已经配好了。');
    process.exit(1);
  }
  const missing = rows.filter((r) => r.have === null);
  if (!missing.length) { console.log('没有缺失的信任条目，不用改。'); process.exit(0); }
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  fs.writeFileSync(`${CONF}.bak.${stamp}`, cfgText, 'utf8');
  const block = missing.map((r) => `[hooks.state.'${r.key}']\ntrusted_hash = "${r.want}"\n`).join('\n');
  fs.writeFileSync(CONF,
    `${cfgText.trimEnd()}\n\n# agentmem-owned Codex hook trust state\n${block}# End agentmem hook trust state\n`, 'utf8');
  console.log(`已补 ${missing.length} 条信任（原文件备份 .bak.${stamp}）：`);
  for (const r of missing) console.log(`  ${r.ev}[${r.gi}.${r.hi}]  ${r.cmd.slice(0, 62)}`);
  process.exit(0);
}

let ok = 0; let bad = 0; let miss = 0;
for (const r of rows) {
  const st = r.have === null ? '缺失  ' : r.have === r.want ? '一致 ✅' : '不一致 ❌';
  if (r.have === null) miss += 1; else if (r.have === r.want) ok += 1; else bad += 1;
  console.log(`  ${st}  ${r.ev}[${r.gi}.${r.hi}]  ${r.cmd.slice(0, 52)}`);
  if (r.have && r.have !== r.want) {
    console.log(`          config 里 ${r.have.slice(7, 27)} / 算出来 ${r.want.slice(7, 27)}`);
  }
}
console.log(`\n一致 ${ok} / 不一致 ${bad} / 缺失 ${miss}`);
console.log(bad ? '❌ 算法对不上，不要 --write' : '✅ 算法与 codex 现有条目一致，可以 --write');
process.exit(bad ? 1 : 0);
