// ============================================================================
// agentmem-dsh-recall —— 给 dsh 补上「自动唤起记忆」。
//
// 为什么不用官方的 dsh-hooks-claude-code：
// 它把 Claude Code 的 UserPromptSubmit 挂在 `agent/pre-step` 上，开头有一行
//     if (messages.length === 0) return next();
// 而 dsh 自己的代码里写明了 `messages` 是「offered continuation」**不是用户的 prompt**
// （dsh-agent/lib/index.js:163 附近，注释原文 "The loop skips an empty first step
// and an emptied offered continuation."）。用户发第一句话时 messages 正好是空的，
// 于是唯一需要它的那一次被跳过了 —— hook 一次都不触发，而且不报错。
//
// 这个插件走同一个 seam，但自己去找用户那句话，找到了才调 agentmem 的召回 hook，
// 把命中的记忆作为一条 user message 追加到下游消息里（和官方桥接注入的方式一致）。
//
// 失败一律吞掉：它挡在用户和模型之间，宁可不注入，不可挡路。
// ============================================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'agentmem-dsh-recall';

const ROOT = process.env.AGENTMEM_HOME || path.join(os.homedir(), '.agentmem');
const HOOK = path.join(os.homedir(), 'dev', 'agentmem', 'bin', 'recall-hook.mjs');
const LOG = path.join(ROOT, 'dsh-recall.log');

function log(line) {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()}  ${line}\n`, 'utf8');
  } catch { /* 日志写不了也不能挡路 */ }
}

// 把各种形状的 content 块摊平成文本。dsh 的消息 content 是块数组。
function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

// 用户那句话可能出现在三个地方，按可能性依次找。
// 三处都试是因为 dsh 在不同步骤里把它放在不同位置 —— 只认一处就会像官方桥接那样漏掉。
function findUserPrompt(payload, downstream) {
  const pools = [
    payload && payload.messages,
    downstream && downstream.messages,
    payload && payload.agent && payload.agent.session && payload.agent.session.messages,
  ];
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    // 从后往前找最近一条用户消息
    for (let i = pool.length - 1; i >= 0; i--) {
      const m = pool[i];
      if (!m || typeof m !== 'object') continue;
      if (m.role && m.role !== 'user') continue;
      const t = blocksToText(m.content).trim();
      if (t) return t;
    }
  }
  return '';
}

export function apply(ctx, config = {}) {
  const agent = config.agent || 'dsh';
  const seen = new Set();   // 每会话只注入一次，和 claude/codex 的纪律一致

  ctx.on('agent/pre-step', async (payload, next) => {
    const downstream = await next();
    try {
      if (!downstream || downstream.kind !== 'enter') return downstream;

      const sid = String(payload?.agent?.session?.id || payload?.agent?.id || '');
      const step = payload?.step;
      const prompt = findUserPrompt(payload, downstream);

      log(`pre-step step=${step} sid=${sid.slice(0, 8)} `
        + `payload.messages=${payload?.messages?.length ?? '-'} `
        + `downstream.messages=${downstream.messages?.length ?? '-'} `
        + `prompt=${prompt ? `${prompt.length}字「${prompt.slice(0, 40).replace(/\s+/g, ' ')}」` : '(没找到)'}`);

      if (!prompt || prompt.length < 12) return downstream;
      if (sid && seen.has(sid)) return downstream;
      // 别把自己注入的块又当成用户提问
      if (prompt.startsWith('【相关记忆')) return downstream;
      if (sid) seen.add(sid);

      const out = execFileSync(process.execPath, [HOOK, '--agent', agent], {
        input: JSON.stringify({ session_id: sid, prompt }),
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (!out) { log('  召回无命中，不注入'); return downstream; }

      const text = JSON.parse(out)?.hookSpecificOutput?.additionalContext;
      if (!text) { log('  hook 输出里没有 additionalContext'); return downstream; }

      log(`  注入 ${text.length} 字`);
      return {
        ...downstream,
        messages: [...(downstream.messages ?? []),
          createUserMessage({ content: [{ type: 'text', text }], source: name })],
      };
    } catch (e) {
      log(`  失败（已忽略）：${String(e && e.message).split('\n')[0].slice(0, 120)}`);
      return downstream;
    }
  });
}
