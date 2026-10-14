#!/usr/bin/env node
// ============================================================================
// agentmem —— 五个 agent（claude / codex / kimi / dsh / gemini）共享的本地记忆。
//
// 为什么是 CLI 而不是 MCP：实测本机 MCP 只覆盖 5 个里的 4 个（dsh 未确认），
// 而 5 个都能跑 shell。地基不能压在只覆盖 4/5 的通道上。
//
// 为什么真相源是每 agent 一个 append-only JSONL，而不是一个 SQLite：
// 本机前科 —— claude-memo 曾被 25 个孤儿进程锁死数据库，那时还只有 1 个 agent。
// 每个 agent 只写自己的文件，写冲突在物理上不存在；SQLite 降级成派生索引，
// 坏了删掉重建即可。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'libsql';
import { cmdScribe, cmdReview, cmdPending } from '../lib/scribe.mjs';
import { appendVerified, completeLines } from '../lib/jsonl.mjs';

const ROOT = process.env.AGENTMEM_HOME || path.join(os.homedir(), '.agentmem');
const LOG_DIR = path.join(ROOT, 'log');
const PRESENCE_DIR = path.join(ROOT, 'presence');
const INDEX_PATH = path.join(ROOT, 'index.sqlite');
// 在线判定 15 分钟。读时按 ts 过滤而不是定时清理 —— 没有人会去维护清理任务，
// 而「过期即失效」是不需要维护的形态。
const PRESENCE_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------- 参数解析
// 不引入 CLI 框架：四个命令、六七个选项，手写比依赖便宜。
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function die(msg) {
  process.stderr.write(`memo: ${msg}\n`);
  process.exit(1);
}

// 归属错了比没有更糟：缺身份一律拒绝，绝不默认成某个 agent。
function resolveAgent(args) {
  const name = (typeof args.agent === 'string' && args.agent.trim())
    || (process.env.AGENTMEM_AGENT || '').trim();
  if (!name) {
    die('缺少 agent 身份。设置环境变量 AGENTMEM_AGENT，或传 --agent <名字>。'
      + '\n     不提供默认值是刻意的：记错归属比没有归属更糟。');
  }
  if (!/^[\w.:-]+$/.test(name)) die(`agent 名只允许字母数字和 . : _ -，收到：${name}`);
  return name;
}

function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(PRESENCE_DIR, { recursive: true });
}

// ---------------------------------------------------------------- presence
// 任何一次调用都刷新在线状态：agent 不会记得单独「报到」，
// 所以让 presence 成为「用了记忆」的副产品，不依赖自律。
function touchPresence(agent, task) {
  const file = path.join(PRESENCE_DIR, `${agent}.json`);
  const rec = {
    agent,
    cwd: process.cwd(),
    task: task || '',
    ts: new Date().toISOString(),
    pid: process.pid,
  };
  try {
    fs.writeFileSync(file, JSON.stringify(rec), 'utf8');
  } catch {
    // 状态写不进去不该让主命令失败：它是辅助信息，不是数据。
  }
}

function readPresence(selfAgent) {
  const now = Date.now();
  const out = [];
  let names;
  try { names = fs.readdirSync(PRESENCE_DIR); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(PRESENCE_DIR, n), 'utf8'));
    } catch {
      // 单个状态文件损坏时当这个 agent 不在线，不能让它拖垮整条查询。
      continue;
    }
    if (!rec || rec.agent === selfAgent) continue;
    if (now - Date.parse(rec.ts || 0) > PRESENCE_TTL_MS) continue;
    out.push(rec);
  }
  return out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

// Windows 上大小写和分隔符都可能不一致，比较前先归一。
function normPath(p) {
  return path.resolve(p || '').replace(/\\/g, '/').toLowerCase();
}

// 冲突判据：同一目录，或一方是另一方的祖先。
// 这才是「并行看见对方」的有用形态 —— 五个 agent 的动态流会淹死人，
// 真正要的是「你正要动的目录，别人刚动过」。
function overlaps(a, b) {
  const x = normPath(a); const y = normPath(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

// ---------------------------------------------------------------- 索引
const CREATE_INDEX_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS mem USING fts5(
  id UNINDEXED, agent UNINDEXED, ts UNINDEXED, cwd UNINDEXED,
  type UNINDEXED, tags, title, text, tokenize='trigram'
)`;

// 水位表：记住每个日志文件已经索引到第几行。
// 日志是 append-only，所以「已索引行数」就是可靠水位，不需要比对内容。
const CREATE_MARK_SQL = 'CREATE TABLE IF NOT EXISTS srcmark(file TEXT PRIMARY KEY, lines INTEGER NOT NULL)';
const CREATE_VEC_SQL = 'CREATE TABLE IF NOT EXISTS vec(id TEXT PRIMARY KEY, v BLOB NOT NULL)';

function openIndex() {
  const db = new Database(INDEX_PATH);
  db.prepare(CREATE_INDEX_SQL).run();
  db.prepare(CREATE_MARK_SQL).run();
  db.prepare(CREATE_VEC_SQL).run();
  return db;
}

// ---------------------------------------------------------------- 向量
// 为什么敢加回来：实测加载模型 574ms、算一个查询向量 6ms、常驻 491MB。
// 之前担心「五个 agent 各 570MB = 2.8GB」，那是**常驻进程**才成立的账；
// memo 是短命 CLI，跑完就退出，内存立刻还回去。所以不需要守护进程。
//
// add 仍然不碰模型：只有 recall / reindex 才加载。写入永远是毫秒级。
let cachedPipe = null;
async function embedder() {
  if (cachedPipe) return cachedPipe;
  const { pipeline, env } = await import('@huggingface/transformers');
  // 模型缓存放数据目录，不放 node_modules —— npm install 会清空后者。
  // 但**允许单独指定**：测试每次用一个临时 AGENTMEM_HOME，跟着它走的话
  // 每跑一次验收就要重下 130MB 模型（实测会直接 fetch failed）。缓存是机器级的，不是库级的。
  env.cacheDir = process.env.AGENTMEM_MODEL_CACHE || path.join(ROOT, 'model-cache');
  cachedPipe = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' });
  return cachedPipe;
}

// e5 模型要求查询句加 "query: "、被检索的文档加 "passage: " 前缀。
async function embedMany(texts, prefix) {
  const pipe = await embedder();
  const out = [];
  for (const t of texts) {
    const r = await pipe(prefix + String(t).slice(0, 2000), { pooling: 'mean', normalize: true });
    out.push(Float32Array.from(r.data));
  }
  return out;
}

function vecToBlob(v) {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

// 坑（在上一个项目里踩过，代价是「语义检索看起来正常但排序完全随机」）：
// libsql 取 BLOB 的类型**随取法而变** —— get() 给 Buffer，all() 给裸 ArrayBuffer，
// 而 ArrayBuffer 既不可迭代也没有 length，Uint8Array.from() 对它静默返回空数组。
// 于是每条向量都解码成长度 0，cosine 全返回 0，排序退化成插入序，且毫无报错。
// 三种形态都必须兜住。
function blobToVec(b) {
  const bytes = b instanceof ArrayBuffer
    ? new Uint8Array(b)
    : ArrayBuffer.isView(b)
      ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
      : Uint8Array.from(b);
  const owned = new Uint8Array(bytes);  // 复制一份：独占内存且起点对齐
  return new Float32Array(owned.buffer);
}

// ---------------------------------------------------------------- 精排（交叉编码器）
//
// 为什么要第二段：**双编码器的余弦分不开相关与无关**。实测在本机真实库上 ——
//   相关 0.888–0.911 / 无关 0.859–0.886，**重叠**。
// 零成本的统计替代也试过，都重叠：z 分数（相关 2.17–3.71 / 无关 1.90–2.62）、
// top1−top5 落差（0.006–0.018 / 0.002–0.010）。
// 这不是调参能解决的：双编码器把 query 和 doc **分开编码**，两者没有交互。
//
// 交叉编码器把 query+doc 拼在一起过一遍 attention，于是能判出
// 「no kernel image ↔ Volta/sm_70」这种要领域知识的关联。
// 2026-09-28 在 22 条真查询 + 6 条真闲聊上重测（分数已改成逐条算，稳定可比）：
//   该命中的 2.51 ~ 6.63（另有 4 条拿负分，见下）/ 不该注入的 0.11 ~ 2.42。
// **门槛不在 0，在 2.5**，写在 recall-hook.mjs 里（那是唯一做注入决策的地方）。
//
// ⚠️ 必须喂**标题 + 正文**。只喂标题时那条最关键的（GPU→Volta）得分比无关的还低，
//    我差点据此判定「reranker 不行」—— 判据大多在正文里，只喂标题等于把证据藏起来。
// ⚠️ 必须取**原始 logit**：text-classification pipeline 的 score 过了 sigmoid，
//    八对全部饱和成 1.00000。
//
// ⚠️ **必须逐条算，不能打成一批。**（2026-09-28 实测，推翻了上一版「0 是模型自带的
//    校准点」那句话。）同一个 (查询, 条目) 对，单独算 −2.64、混在 30 条批次里算 −1.93，
//    换一批陪跑的又变 −2.20 / −2.14 —— **摆动 0.71 个 logit**。
//    补齐长度不是原因：强行定长到 512 之后三组批算的值一个没变，组间仍差 0.27。
//    是 **q8 动态量化的 scale 按整批张量算**，别的行的数值大小会挪动本行的量化误差。
//    代价是真实发生过的：同一条闲聊 prompt 两次运行一次判 −2.13 一次判 +0.07，
//    也就是**注入与否在抛硬币**，而我当时把它当成「阈值定得准」汇报了。
//    逐条算之后分数是 (查询, 条目) 的纯函数（重算逐字节一致），
//    而且**反而快 3.5 倍**：30 条逐条 555ms vs 打成一批 1977ms ——
//    批处理要把每行补齐到最长那行（~512 token），短文档全在陪跑空算。
//    （所以上一版「q8 分离度比 fp32 好 5.49 vs 4.22」那个数也是在批次里测的，不可信。）
//
// 模型名与阈值**绑在一起写**：换模型阈值就变，分开放迟早对不上。
// 允许用环境变量覆盖模型名。两个理由：
//   ① 模型名会腐烂 —— HF 上的镜像改名/下线时，不用改代码就能换掉；
//   ② 可测 —— 验收里把它指向一个不存在的模型，来证明「精排挂了 recall 仍然工作」。
//      没有这个口子，那条降级路径就只能靠嘴说，测不到。
const RERANK_MODEL = process.env.AGENTMEM_RERANK_MODEL || 'Xenova/bge-reranker-base';
const RERANK_DTYPE = 'q8';        // 实测 q8 分离度比 fp32 还好（5.49 vs 4.22），且快一倍
// 粗筛交给精排的候选数。**这个数要明显大于最终返回的 limit** ——
// 两段式的意义是「粗筛放宽、精排收紧」，候选池太小等于没做第二段。
// 逐条 19ms（不是原来算的 77ms —— 那是批算被补齐拖慢后的数），所以池子便宜了：
// 30 条 ≈ 0.6s，一个会话付一次，换来正确记忆排在第 5/第 9 时也能被捞出来。
// 允许环境变量覆盖，为的是**能测批次无关性**：同一条目在池 8 和池 30 下必须同分。
// 没有这个口子，「逐条算所以分数稳定」就只能靠嘴说。
const RERANK_POOL = Number(process.env.AGENTMEM_RERANK_POOL) || 30;
const RERANK_SIM_FLOOR = 0.87;    // 粗筛都没到这个线，就别为它加载 266MB 模型

let cachedRanker = null;
async function reranker() {
  if (cachedRanker) return cachedRanker;
  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@huggingface/transformers');
  env.cacheDir = process.env.AGENTMEM_MODEL_CACHE || path.join(ROOT, 'model-cache');
  const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL);
  const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: RERANK_DTYPE });
  cachedRanker = { tokenizer, model };
  return cachedRanker;
}

// 给候选打精排分。**任何失败都返回 null 让调用方退回余弦** ——
// 精排是增强不是依赖：模型拉不到（首次要下 266MB）、ONNX 崩了、超时，
// 都不该让整个 recall 失败。降级要静默且可见（走 stderr，不污染 stdout）。
async function rerank(query, rows) {
  try {
    const { tokenizer, model } = await reranker();
    const out = [];
    // **逐条算，不打成一批。** 见上面「逐条」那段：批算的分数会被同批其他条目挪动，
    // 而且还更慢。
    for (const r of rows) {
      const doc = `${r.title || ''}。${(r.text || '').slice(0, 800)}`;
      const inputs = await tokenizer([query], { text_pair: [doc], truncation: true });
      const { logits } = await model(inputs);
      out.push(logits.tolist()[0][0]);
    }
    return out;
  } catch (e) {
    process.stderr.write(`memo: 精排不可用，退回纯余弦（${String(e && e.message).split('\n')[0].slice(0, 70)}）\n`);
    return null;
  }
}

// ---------------------------------------------------------------- 字面路的词项切分
//
// ⚠️ 原来这里把**整句当短语**查（`"dsh 的会话记录存在哪里"`）。trigram 分词器下
//    短语 = 连续子串，于是**任何真实查询都恒返回 0 条** —— 字面路一直是死的，
//    混合检索实际退化成纯语义。而 `·字面` 标记从没在输出里出现过，光看结果看不出来。
//    实测同一查询：整句短语 0 条 / 隐式 AND 0 条 / 按词项 OR **5 条且正确的全在里面**。
//
// 为什么不引入中文分词器：**trigram 索引本身就是分词器**。把查询切成 3 字窗口逐个 OR，
// bm25 的 IDF 会自动压低「怎么办」「的问题」这类到处都有的窗口、抬高「会话记」这种罕见的。
// 这是 R13 那条「优先选不需要枚举形态的设计」—— 停用词表要跟着新说法永远赛跑，IDF 不用维护。
const MAX_LEX_TERMS = 40;   // 自动唤起拿整句 prompt 当查询，不封顶会切出上百个窗口

// 字面路只取前 12 条，比语义路少得多。**这不是随手调的参数，是 RRF 的算术决定的**：
// 两条路权重相同、融合后的池子封顶 RERANK_POOL，于是 top-30 ≈ 各路 top-15。
// 第一版字面路也取 30 条，实测把语义路第 16–30 名整段挤掉了 ——
// 基准里「第一次跑自动记录把所有历史会话都翻了一遍」原本在语义第 28 名，
// 改完直接掉出候选池，**修召回反而弄丢了一条**。
// 12 这个数的依据是字面路的职责：它是来捞**罕见字面串**的（标识符、报错原文、版本号），
// 这类东西 IDF 高、必然落在 bm25 最前面；第 12 名之后就只是共享了某个常见三字窗口的噪声。
const LEX_LIMIT = 12;

function lexTerms(query) {
  const fts = []; const like = [];
  // 拉丁/数字串走第一分支，其余文字（中日韩等）走第二分支；标点和空白都是分隔符。
  for (const run of String(query).match(/[A-Za-z0-9_.-]+|[\p{L}\p{N}]+/gu) || []) {
    if (/^[A-Za-z0-9_.-]+$/.test(run)) {
      if (run.length >= 3) fts.push(run.toLowerCase());   // 1–2 字符的拉丁串是噪声
      continue;
    }
    const cs = [...run];
    // 两字中文 trigram 索引不到（「额度」命中 0，「额度耗」命中），只能走 LIKE；
    // 单字不查 —— 一个汉字能 LIKE 中半个库。
    if (cs.length < 3) { if (cs.length === 2) like.push(run); continue; }
    for (let i = 0; i + 3 <= cs.length; i++) fts.push(cs.slice(i, i + 3).join(''));
  }
  return {
    fts: [...new Set(fts)].slice(0, MAX_LEX_TERMS),
    like: [...new Set(like)].slice(0, 4),
  };
}

// 向量已归一化，点积即余弦。长度对不上一律返回 0（当作不相似）。
function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// 把日志里还没进索引的行补进去。
//
// 为什么不在 add 里写索引：索引是**所有 agent 共用的一个 SQLite**，
// 在 add 里写等于把「写冲突」从 JSONL 请回到索引上 —— 实测 100 个并发 add
// 会互相撞锁，600 秒没跑完。add 现在只做纯文件追加（无锁、无 SQLite），
// 补索引推迟到 recall，反正只有检索才需要它。
async function syncIndex(db, { quiet = true } = {}) {
  let files;
  try { files = fs.readdirSync(LOG_DIR); } catch { return 0; }
  const getMark = db.prepare('SELECT lines FROM srcmark WHERE file=?');
  const setMark = db.prepare('INSERT INTO srcmark(file,lines) VALUES (?,?) '
    + 'ON CONFLICT(file) DO UPDATE SET lines=excluded.lines');
  const putVec = db.prepare('INSERT OR REPLACE INTO vec(id,v) VALUES (?,?)');

  // 先把待办全收集起来，再统一算向量：算向量是这里唯一慢的一步，
  // 批量做才好给进度，也避免在事务里干耗。
  const pending = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    // 只认完整的行：add 不加锁，读的这一刻可能有人正写到一半（见 lib/jsonl.mjs 的 completeLines）。
    const lines = completeLines(fs.readFileSync(path.join(LOG_DIR, f), 'utf8'));
    const done = getMark.get(f)?.lines ?? 0;
    if (lines.length <= done) continue;
    for (const line of lines.slice(done)) {
      try { pending.push(JSON.parse(line)); } catch { /* 坏行跳过，不让一行毁掉索引 */ }
    }
    setMark.run(f, lines.length);
  }
  if (!pending.length) return 0;

  // 墓碑：`memo forget <id>` 往日志里追加一条 {forget: 目标id}，这里据此把它从索引里删掉。
  //
  // 为什么需要：**系统会忠实记下我说错的话。** 2026-09-23 实测 ——
  // 我在会话里把一个路径分隔符引起的误判当成结论说了出来，scribe 照抄，
  // 引证闸逐字核对**通过**（那句话我确实说了），异族审核也放行（它判不了被引用的话本身是错的）。
  // 于是假记忆进库。日志是 append-only 真相源不能改，所以用墓碑：
  // 原记录留着（「当时确实这么认为」也是事实），但不再被检索到。
  const graves = pending.filter((r) => r && r.forget).map((r) => String(r.forget));
  if (graves.length) {
    const delMem = db.prepare('DELETE FROM mem WHERE id=?');
    const delVec = db.prepare('DELETE FROM vec WHERE id=?');
    db.transaction(() => { for (const g of graves) { delMem.run(g); delVec.run(g); } })();
  }
  const live = pending.filter((r) => r && !r.forget && !graves.includes(String(r.id)));
  if (!live.length) return 0;

  db.transaction(() => { for (const r of live) indexOne(db, r); })();

  if (!quiet) process.stderr.write(`  正在为 ${live.length} 条算向量…\n`);
  const vectors = await embedMany(
    live.map(r => `${r.title || ''}\n${r.text || ''}`),
    'passage: '
  );
  db.transaction(() => {
    live.forEach((r, i) => putVec.run(r.id, vecToBlob(vectors[i])));
  })();

  return live.length;
}

function indexOne(db, rec) {
  db.prepare('INSERT INTO mem(id,agent,ts,cwd,type,tags,title,text) VALUES (?,?,?,?,?,?,?,?)')
    .run(rec.id, rec.agent, rec.ts, rec.cwd || '', rec.type || '',
      (rec.tags || []).join(' '), rec.title || '', rec.text || '');
}

// ---------------------------------------------------------------- 命令
function cmdAdd(agent, args) {
  const title = typeof args.title === 'string' ? args.title : '';
  let text = '';

  // 读 stdin 必须是**显式**的。
  // 坑：早先写成「--text 缺失就读 stdin」，结果被 execFile 之类以管道方式起的调用
  // 永久阻塞 —— 那种 stdin 是个永不关闭的管道，readFileSync(0) 会一直等。
  // agent 调这个 CLI 基本都走管道，所以这是必然踩的，不是边缘情况。
  if (typeof args.text === 'string') {
    text = args.text;
  } else if (args.stdin === true) {
    try { text = fs.readFileSync(0, 'utf8'); } catch { text = ''; }
  }

  if (!title && !text.trim()) die('add 需要 --title，或正文（--text "…" / 管道进来加 --stdin）。');

  const rec = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    agent,
    cwd: process.cwd(),
    type: typeof args.type === 'string' ? args.type : 'note',
    title,
    text: text.trim(),
    tags: typeof args.tags === 'string' ? args.tags.split(',').map(s => s.trim()).filter(Boolean) : [],
  };

  // 纯文件追加：不开 SQLite、不加锁。索引由 recall 惰性补齐。
  // 不拿 writer 锁是刻意的：agent 高频调它，不能被一个跑几分钟的 review 挡住。
  // 代价是可能和 review 同时往同一个文件追加 —— 所以写完回读确认，没写完整就重写（见 lib/jsonl.mjs）。
  let tries;
  try { tries = appendVerified(path.join(LOG_DIR, `${agent}.jsonl`), rec); } catch (e) { die(String(e.message)); }
  if (tries > 1) process.stderr.write('memo: 第一次没写完整（可能撞上了并发写入），已重写一次\n');
  process.stdout.write(`已记录 ${rec.id}  [${rec.agent}] ${rec.title || rec.text.slice(0, 40)}\n`);
}

// 撤回一条记错的记忆。日志是 append-only 真相源，所以不删行，追加墓碑。
// 原记录留着 —— 「当时确实这么认为」本身也是事实，抹掉它就没法回答「闸为什么放行」。
function cmdForget(agent, args) {
  const target = String(args._[0] || '').trim();
  if (!target) die('forget 需要目标 id：memo forget <id> [--reason "…"]');
  const rec = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    agent,
    forget: target,
    reason: typeof args.reason === 'string' ? args.reason : '',
  };
  try { appendVerified(path.join(LOG_DIR, `${agent}.jsonl`), rec); } catch (e) { die(String(e.message)); }
  process.stdout.write(`已墓碑 ${target}${rec.reason ? `（${rec.reason}）` : ''}
`);
}

async function cmdRecall(agent, args) {
  const query = args._.join(' ').trim();
  if (!query) die('recall 需要查询词。');
  const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 50) : 8;
  const db = openIndex();
  await syncIndex(db);   // 惰性补齐：add 只写日志，索引在这里追上

  // ---- 字面路：按词项 OR，不是整句短语（见上面 lexTerms 那段的实测）
  // 粗筛要捞够喂给精排的量。原来是 limit*2 —— limit=3 时只有 6 条，
  // 池子再大也填不满，正确记忆排在第 9 就永远进不来。
  const cand = Math.max(limit * 2, RERANK_POOL);
  const { fts, like } = lexTerms(query);
  const lexSeen = new Set();
  const lexical = [];
  const takeLex = (rows) => {
    for (const r of rows) if (!lexSeen.has(r.id)) { lexSeen.add(r.id); lexical.push(r); }
  };
  if (fts.length) {
    // 每个词项单独加引号当短语（一个 3 字窗口 = 恰好一个 trigram token），
    // 再 OR 起来。引号内的双引号按 FTS5 规则双写转义。
    const expr = fts.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    try {
      takeLex(db.prepare(
        'SELECT id,agent,ts,type,title,text FROM mem WHERE mem MATCH ? ORDER BY rank LIMIT ?'
      ).all(expr, LEX_LIMIT));
    } catch {
      // 查询串被 FTS5 拒了就当字面路没命中 —— 语义路还在，不能让整个 recall 失败。
    }
  }
  for (const t of like) {
    takeLex(db.prepare(
      `SELECT id,agent,ts,type,title,text FROM mem
       WHERE title LIKE '%'||?||'%' OR text LIKE '%'||?||'%' OR tags LIKE '%'||?||'%'
       ORDER BY ts DESC LIMIT ?`
    ).all(t, t, t, LEX_LIMIT));
  }

  // ---- 语义路：这是加回向量的全部理由 ——
  // 「只记得大概思路、想不起当初用的词」时，字面路一条都召不回。
  const qvec = (await embedMany([query], 'query: '))[0];
  const scored = db.prepare('SELECT v.id AS id, v.v AS v, m.agent, m.ts, m.type, m.title, m.text '
    + 'FROM vec v JOIN mem m ON m.id = v.id').all()
    .map(r => ({ row: r, sim: cosine(qvec, blobToVec(r.v)) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, cand);
  db.close();

  // ---- 融合：RRF。两条路都命中的排前面，各自独有的也保留。
  const merged = new Map();
  const bump = (r, rank, tag) => {
    const cur = merged.get(r.id) || { row: r, score: 0, via: new Set() };
    cur.score += 1 / (60 + rank);
    cur.via.add(tag);
    merged.set(r.id, cur);
  };
  lexical.slice(0, LEX_LIMIT).forEach((r, i) => bump(r, i, '字面'));
  scored.forEach((s, i) => {
    bump(s.row, i, '语义');
    // 把**原始余弦**也带上。RRF 分数只由排名决定（首条恒为 1/(60+0)=0.01667），
    // 拿它当相关度门槛等于没门槛 —— 实测「今天天气怎么样」和真问题的首条分数一模一样。
    // 自动唤起要判「值不值得注入」，只能看余弦。
    const cur = merged.get(s.row.id);
    if (cur) cur.sim = Math.max(cur.sim || 0, s.sim);
  });

  const ranked = [...merged.values()].sort((a, b) => b.score - a.score);

  // ---- 精排：粗筛捞一大把 → 交叉编码器挑 → 再切到 limit
  //
  // ⚠️ 顺序不能反。第一版写成「先切到 limit 再精排」，于是 reranker 只看得到
  //    最终要返回的那几条 —— 正确记忆排在第 5、第 9 时它**根本没机会**。
  //    实测代价：六个该命中的查询有四个 top1 拿负分，而原因全是粗筛没捞上来，
  //    不是精排判错。两段式检索的意义就在于**粗筛放宽、精排收紧**，切早了等于没做。
  let rows;
  const pool = ranked.slice(0, RERANK_POOL);
  const bestSim = Math.max(0, ...pool.map((r) => r.sim || 0));
  if (!args['no-rerank'] && pool.length && bestSim >= RERANK_SIM_FLOOR) {
    const scores = await rerank(query, pool.map((r) => r.row));
    if (scores) {
      pool.forEach((r, i) => { r.rr = scores[i]; });
      pool.sort((a, b) => b.rr - a.rr);
      rows = pool.slice(0, limit);
    } else {
      rows = ranked.slice(0, limit);   // 精排不可用 → 退回粗筛顺序
    }
  } else {
    rows = ranked.slice(0, limit);
  }

  // --json 给调用方完整结果和 RRF 分数。
  // 自动唤起的 hook 需要**按相关度设门槛**：无差别注入会把上下文塞满不相关的东西，
  // 而人读 recall 时可以自己忽略，hook 不能。分数只有这里有，所以必须暴露。
  if (args.json) {
    process.stdout.write(`${JSON.stringify(rows.map(({ row: r, score, sim, rr, via }) => ({
      id: r.id, ts: r.ts, agent: r.agent, type: r.type, title: r.title,
      // rr = 交叉编码器的原始 logit，自动唤起就靠它判注不注入（>0 才注）。
      // null 表示这次没跑精排（粗筛太低，连模型都没加载）—— 调用方一律当作不注入。
      text: r.text, score, sim: sim || 0, rr: typeof rr === 'number' ? rr : null, via: [...via],
    })), null, 0)}\n`);
    return;
  }

  if (!rows.length) { process.stdout.write('没有命中。\n'); return; }
  for (const { row: r, via, rr } of rows) {
    const when = (r.ts || '').replace('T', ' ').slice(0, 16);
    const body = (r.title || r.text || '').replace(/\s+/g, ' ').slice(0, 58);
    // 把精排分打出来：它决定了注入与否，看不见就没法判断门槛合不合适。
    const mark = rr === undefined ? '' : ` ·精排${rr > 0 ? '+' : ''}${rr.toFixed(1)}`;
    process.stdout.write(`${when}  [${r.agent}] ${r.type ? `(${r.type}) ` : ''}${body}  ·${[...via].join('+')}${mark}\n`);
  }
}

function cmdWho(agent) {
  const others = readPresence(agent);
  if (!others.length) { process.stdout.write(`只有 ${agent} 在线。\n`); return; }
  const here = process.cwd();
  for (const o of others) {
    const clash = overlaps(here, o.cwd);
    const mins = Math.round((Date.now() - Date.parse(o.ts)) / 60000);
    process.stdout.write(
      `${clash ? '⚠ 撞车 ' : '       '}[${o.agent}] ${mins} 分钟前  ${o.cwd}${o.task ? `  — ${o.task}` : ''}\n`
    );
  }
  if (others.some(o => overlaps(here, o.cwd))) {
    process.stdout.write('\n上面标 ⚠ 的 agent 和你在同一个目录（或互为上下级），动手前先确认。\n');
  }
}

async function cmdReindex() {
  // 索引是派生的：直接删掉重建，不做增量修复。坏了也不用诊断。
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(INDEX_PATH + suffix, { force: true }); } catch { /* 不存在就算了 */ }
  }
  const db = openIndex();
  const n = await syncIndex(db, { quiet: false });  // 水位全清空后，syncIndex 等价于全量重建
  db.close();
  process.stdout.write(`索引已重建：${n} 条\n`);
}

// scribe/review 要用的那几样能力，打包传过去。
const SCRIBE_CTX = { ROOT, openIndex, syncIndex, embedMany, cosine, blobToVec };

// ---------------------------------------------------------------- 入口
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${[
      'memo —— 多 agent 共享记忆（本地）',
      '',
      '  memo add --title "…" [--text "…"] [--type …] [--tags a,b]   写一条',
      '      正文从管道进来时加 --stdin：  echo "…" | memo add --title "…" --stdin',
      '  memo recall <查询词> [--limit 8] [--no-rerank]                 检索（默认带交叉编码器精排）',
      '  memo who                                                      谁在线 + 撞车预警',
      '  memo reindex                                                  从日志重建索引',
      '',
      '  memo scribe [--agent X] [--init] [--probe]   扫会话记录，自动产出候选记忆',
      '      首次务必先跑 --init：把水位对到当前末尾，否则会回溯全部历史会话',
      '  memo review [--limit N]                      交给**另一个家族**的模型审，通过才进库',
      '  memo pending                                 看待审的和被驳回的',
      '',
      '  身份来自环境变量 AGENTMEM_AGENT，或 --agent <名字>。没有默认值。',
      `  数据在 ${ROOT}`,
    ].join('\n')}\n`);
    return;
  }

  const agent = resolveAgent(args);
  ensureDirs();
  touchPresence(agent, typeof args.task === 'string' ? args.task : '');

  switch (cmd) {
    case 'add': return cmdAdd(agent, args);
    case 'recall': return await cmdRecall(agent, args);
    case 'who': return cmdWho(agent);
    case 'forget': return cmdForget(agent, args);
    case 'reindex': return await cmdReindex();
    // scribe/review 只用到这几样，单独传进去而不是反过来 import：
    // lib 不依赖 bin，就不会有循环引用。
    case 'scribe': return await cmdScribe(SCRIBE_CTX, args);
    case 'review': return await cmdReview(SCRIBE_CTX, args);
    case 'pending': return cmdPending(SCRIBE_CTX);
    default: return die(`未知命令 ${cmd}。可用：add / recall / forget / who / reindex / scribe / review / pending`);
  }
}

main().catch((e) => die(String(e && e.message ? e.message : e)));
