# agentmem — 多 agent 共享记忆（本地，最小实现）

> 作者：bokily · 规格：Claude Opus 5 · 实现：Codex
> 硬约束：**代码量最小，只做最基础功能。** 每加一个功能都要先问「不做会死吗」。

## 0. 它解决什么

这台机器上有 5 个 agent：`claude` `codex` `kimi` `dsh` `gemini`。
它们各自失忆，且**互相看不见** —— 两个 agent 在同一个目录里干活撞过车（这就是 R10a 规则的由来）。

要的是三件事，按重要性排：

1. **共享知识**：任一 agent 写的，其它 agent 能检索到
2. **冲突预警**：我正要动的目录，是不是有别的 agent 刚动过 / 正在动
3. **归属**：每条记忆必须知道是谁写的（agent 自报不可信，这是本机的血泪史）

## 1. 明确不做（范围护栏）

服务器 · 网页界面 · 账号密码 · 多租户/团队层 · 晋升与审核流 · 脱敏 ·
邮件 · 云同步 · 向量/语义检索 · MCP 接入 · 定时任务 · 守护进程。

**理由**：上一个项目就是这么长大然后被放弃的。这些以后想要再说。

## 2. 数据布局

```
~/.agentmem/
  log/<agent>.jsonl        真相源。append-only，每个 agent 独占一个文件
  presence/<agent>.json    在线状态。每次 CLI 调用覆盖写
  index.sqlite             派生索引。可随时删除重建
```

### 为什么真相源不是单个 SQLite

**本机实测过教训**：claude-memo 曾被 25 个孤儿进程锁死数据库，那还只有 **1 个** agent。
5 个并发在 Windows 上只会更糟。

**每个 agent 只写自己的文件 → 写冲突在物理上不存在。** 不需要锁、不需要 WAL 调优、
不需要担心孤儿进程。索引是派生的，坏了删掉重建即可。

### log/<agent>.jsonl 每行

```json
{"id":"<uuid>","ts":"<ISO8601>","agent":"claude","cwd":"C:\\Users\\bokily\\dev\\x",
 "type":"pitfall","title":"…","text":"…","tags":["a","b"]}
```

- `type` 自由字符串，不做枚举校验（上一个项目在这里栽过：HTTP 层强制了数据层不强制的枚举，
  导致已有类型再也写不进去）
- `agent` 从环境变量 `AGENTMEM_AGENT` 取，缺失则用 `--agent`，再缺失报错退出。
  **不许默认成某个值** —— 归属错了比没有更糟

### presence/<agent>.json

```json
{"agent":"claude","cwd":"…","task":"…","ts":"<ISO8601>","pid":1234}
```

**TTL 15 分钟，读时按 `ts` 过滤，不做清理任务。**
理由：没有人会去维护清理任务；过期即失效是不需要维护的形态。

## 3. CLI：四个命令，就四个

命令名 `memo`。

### `memo add`
写一条。内容从 `--title` / `--text` 取，`--text` 缺失时从 stdin 读。
可选 `--type` `--tags`（逗号分隔）。
追加到 `log/<agent>.jsonl`，**同时**增量写入索引。

### `memo recall <query>`
检索。默认返回 8 条，`--limit` 可调。输出必须带 **agent 与 ts**。

**分词规则（已实测，照此实现）**：
- 查询 **≥3 个字符** → FTS5 `MATCH`（trigram 分词器）
- 查询 **<3 个字符** → 退回 `LIKE '%q%'`
  实测：trigram 对 `额度耗`(3字) 命中，对 `额度`(2字) 命中 0；中文两字词极多，必须兜底

### `memo who`
列出 TTL 内的其它 agent（不含自己）。

**冲突预警是这条命令的核心，不是附属**：若对方 `cwd` 与我的当前目录**相同或互为前缀**，
必须显著标出。没有交集的就正常列出。

### `memo reindex`
删掉 `index.sqlite`，从全部 `log/*.jsonl` 重建。

### 所有命令的共同副作用
**任何一次 `memo` 调用都更新调用方的 presence。**
理由：agent 不会记得单独报到；让 presence 成为使用记忆的副产品，不依赖自律。

## 4. 索引

```sql
CREATE VIRTUAL TABLE mem USING fts5(
  id UNINDEXED, agent UNINDEXED, ts UNINDEXED, cwd UNINDEXED,
  type UNINDEXED, tags, title, text,
  tokenize='trigram'
);
```

已实测 trigram 在本机 libsql 上可用。

## 5. 迁移

旧库（claude-memo 的备份 `<旧库路径>.sqlite`）里有 **188 条**历史记忆，要带过来。

- 目标：`log/legacy.jsonl`，`agent` 一律写 `legacy:claude-memo`
- **不许假装是某个 agent 写的**
- 字段映射：`title`→title，`content`→text，`type`→type，`tags`→tags，
  `created_at`→ts，`scope` 并进 tags
- 迁移必须**幂等**：重复执行不产生重复行（按源 id 去重）
- 迁移脚本单独一个文件，不塞进 CLI

## 6. 技术选型

| 项 | 选择 | 为什么不是替代方案 |
|---|---|---|
| 运行时 | Node（已有 v24） | 5 个 agent 都能跑 shell；Python 也行但本机 Node 生态更熟 |
| 存储 | JSONL + SQLite 派生索引 | 单 SQLite 有孤儿进程锁库的实测前科（见 §2） |
| 检索 | FTS5 trigram + LIKE 兜底 | 向量要常驻 570MB 模型，5 个 agent = 2.8GB，收益不抵成本 |
| 依赖 | 只用 `libsql`（本机已有） | 不引入 CLI 框架，`process.argv` 手写足够 |
| 接入 | CLI | 5 个 agent 全能跑 shell；MCP 只覆盖 4/5，不能当地基 |

## 7. 验收（机器可判定）

1. 两个不同 `AGENTMEM_AGENT` 并发各写 50 条，**两个文件都完整，无交叉污染**
2. `memo recall` 对 3 字符中文命中；对 2 字符中文也命中（走 LIKE 兜底）
3. 删掉 `index.sqlite` 后 `memo reindex`，检索结果与删除前**一致**
4. `memo who` 在 cwd 相同时标出冲突；TTL 外的条目不出现
5. 缺 `AGENTMEM_AGENT` 且无 `--agent` 时**报错退出**，不写入
6. 迁移脚本跑两次，`legacy.jsonl` 行数不变（幂等）
