#!/usr/bin/env node
// ============================================================================
// 把 claude-memo 的历史记忆迁进 agentmem。
//
// 幂等：按源 id 去重，跑几次结果都一样 —— 迁移脚本被重复执行是常态，
// 不幂等的迁移会在第二次运行时悄悄制造重复。
//
// 归属一律写 legacy:claude-memo，**不假装是某个 agent 写的**。
// 那 188 条是单人时代的产物，硬塞给某个 agent 会污染「谁说的」这条线索，
// 而归属正是这套系统存在的理由之一。
//
// 用法：
//   node scripts/migrate-legacy.mjs --db <源库> [--dry-run]
// 源库只读，绝不写入。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'libsql';

const LEGACY_AGENT = 'legacy:claude-memo';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv);
if (typeof args.db !== 'string' || !args.db.trim()) {
  process.stderr.write('用法: node scripts/migrate-legacy.mjs --db <源库> [--dry-run]\n'
    + '--db 必填且无默认值：迁移脚本绝不猜测该读哪个库。\n');
  process.exit(1);
}

const ROOT = process.env.AGENTMEM_HOME || path.join(os.homedir(), '.agentmem');
const LOG_DIR = path.join(ROOT, 'log');
const TARGET = path.join(LOG_DIR, `${LEGACY_AGENT.replace(/:/g, '_')}.jsonl`);

if (!fs.existsSync(args.db)) {
  process.stderr.write(`源库不存在：${args.db}\n`);
  process.exit(1);
}

// 已迁过的源 id，用于幂等。
const already = new Set();
if (fs.existsSync(TARGET)) {
  for (const line of fs.readFileSync(TARGET, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.src) already.add(String(r.src));
    } catch { /* 坏行跳过 */ }
  }
}

const db = new Database(args.db, { readonly: true });
const rows = db.prepare(
  'SELECT id, scope, type, title, content, summary, tags, pinned, created_at FROM memories ORDER BY id'
).all();
db.close();

const lines = [];
let skipped = 0;
for (const r of rows) {
  if (already.has(String(r.id))) { skipped += 1; continue; }

  // tags 在源库里是 JSON 数组或逗号串，两种都兜住。
  let tags = [];
  if (typeof r.tags === 'string' && r.tags.trim()) {
    try {
      const parsed = JSON.parse(r.tags);
      tags = Array.isArray(parsed) ? parsed : String(r.tags).split(',');
    } catch {
      tags = String(r.tags).split(',');
    }
  } else if (Array.isArray(r.tags)) {
    tags = r.tags;
  }
  tags = tags.map(t => String(t).trim()).filter(Boolean);
  // scope 并进 tags：agentmem 没有 scope 概念，但这条信息不该丢。
  if (r.scope) tags.push(String(r.scope));
  if (r.pinned) tags.push('pinned');

  lines.push(JSON.stringify({
    id: `legacy-${r.id}`,
    src: String(r.id),
    ts: new Date(String(r.created_at || '').replace(' ', 'T') + 'Z').toISOString(),
    agent: LEGACY_AGENT,
    cwd: '',
    type: r.type || 'note',
    title: r.title || '',
    // summary 拼进正文：它是当年为 snippet 召回写的一句话摘要，检索时有用。
    text: [r.summary, r.content].filter(Boolean).join('\n\n'),
    tags,
  }));
}

if (args['dry-run']) {
  process.stdout.write(`预览：源 ${rows.length} 条，已存在 ${skipped} 条，本次将写入 ${lines.length} 条\n`);
  process.exit(0);
}

fs.mkdirSync(LOG_DIR, { recursive: true });
if (lines.length) fs.appendFileSync(TARGET, `${lines.join('\n')}\n`, 'utf8');

const total = fs.readFileSync(TARGET, 'utf8').split('\n').filter(l => l.trim()).length;
process.stdout.write(
  `迁移完成：源 ${rows.length} 条，本次写入 ${lines.length} 条，跳过已存在 ${skipped} 条，`
  + `目标文件现有 ${total} 条\n记得跑 memo reindex\n`
);
