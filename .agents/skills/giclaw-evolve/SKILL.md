---
name: giclaw-evolve
description: "Use this skill whenever you work on giclaw's self-iteration (\"loop evolution\") system, or whenever a giclaw skill needs to be diagnosed and fixed. It drives one tight develop → validate → run → read-evidence cycle so you can build the evolve engine while actually executing it: snapshot an SKILL.md, install a candidate under ~/.giclaw/skills, run it in the visible browser, read the transcript and failure screenshots, then promote or roll back. Trigger it even when the user only says a giclaw task \"failed\", \"broke after the update\", \"keeps misclicking\", \"timed out at step N\", asks to \"make giclaw improve/fix itself\", \"add self-improvement / auto-fix / evolution / evolve loop\", or wants to safely test a modified skill without dirtying the repo. Do NOT use it for authoring a brand-new giclaw skill from scratch (see the giclaw docs) or for generic browser automation."
license: MIT
compatibility: Requires the giclaw repo (Node >= 20.9, pnpm). Structural validation is offline; real runs need a vision model configured in ~/.giclaw/config.json and a logged-in cloud-game cookie.
metadata:
  version: "0.3.0"
  target: giclaw
---

# giclaw 自我迭代 Loop 进化系统（开发 / 调试 / 执行一体）

让 giclaw 基于**真实运行证据**发现自己的 `SKILL.md` 哪里坏了，产出最小补丁，在真实浏览器里重跑验证，成功则保留、失败则回滚。

这个 skill 服务于两件事，它们是同一个循环：

1. **扩展引擎**：在 `src/evolve/**` 里改进自动诊断 / 补丁 / 预算 / 审批（主干已落地，见 Slice 4）。
2. **用引擎（或手工做它的事）**：修一个具体失败的技能。

因为整件事很复杂，**不要**先写完整引擎再运行。下面每个「垂直切片」都能立刻真实跑一次；每次只改一点点，立刻 validate、立刻用真浏览器执行、立刻读证据，再改。

## 何时使用 / 不适用

**使用**：giclaw 技能运行失败、更新后回归、等待/点击步骤不稳；要实现或修改 `giclaw evolve` 循环；要无污染地试一版被修改的 `SKILL.md`；要安全回滚。

**不使用**：从零写一个新 giclaw 技能（用项目文档 `docs/docs/skills/writing-skills.md`）；与 giclaw 无关的一般浏览器自动化；只做 git 回滚或通用单测。

## 进度清单

把这条清单复制进你的回复并逐步勾选，避免跳步：

```
- [ ] 1. 明确目标技能与失败现象（或要实现的 slice）
- [ ] 2. 先跑 run-skill.sh --dry-run / validate-skill，确认结构
- [ ] 3. snapshot-skill.sh 快照当前 SKILL.md
- [ ] 4. loop.sh 跑一轮，读 transcript + 截图，定位失败 step
- [ ] 5. 写最小补丁 → candidate.sh 安装候选
- [ ] 6. loop.sh 重跑候选
- [ ] 7. 成功 → promote.sh；回归 → rollback.sh
- [ ] 8. 更新 references/design.md 的 generation 记录约定（若引擎已实现）
```

## 核心不变量（以及为什么）

1. **只改 `SKILL.md`，不生成/执行任意代码。** 这是 giclaw 可审计、可回滚的前提；一旦允许自生成代码，失败就不再能通过 diff 复盘。
2. **一次只进化一个技能，走现有串行 FIFO 队列。** 浏览器登录与游戏状态不可并发；两个管线重叠会产生互相污染的副作用。
3. **候选先校验后运行。** 先用 `loadSkills` 严格校验（kebab id、非空 Steps、合法原子操作、无依赖环），再决定是否花一次真实浏览器运行的成本。
4. **有界 + 可回滚。** 迭代次数、时间、模型调用、diff 行数都有上限；每次改动前先快照。达到上限就停在 best-known-good。
5. **红线不可引入。** 禁止购买、消耗原石/付费货币、不可逆操作。改动越接近货币与不可逆行为，越要拒绝而不是"试试看"。
6. **真实账号验收不可省。** dry-run 与单测只证明结构正确，不能证明游戏里真的点对了。

## 进化循环（每一代）

`OBSERVE → DIAGNOSE → PROPOSE → VALIDATE（硬门禁）→ APPLY → RE-RUN → EVALUATE`

- **VALIDATE 是硬门禁**：不过 loader、过不了红线策略、diff 超限，就**不要**运行，直接拒绝并保留 baseline。把失败成本从"一次真实浏览器运行"降到"一次本地校验"。
- **EVALUATE 同时看成功与耗时**：成功但显著变慢（默认 `> baseline × 1.5`）也算回归，因为云游戏排队/时长有成本。
- 每一代落一条记录（结构见 `assets/generation-record.example.json`），让"为什么接受/拒绝"可追溯。

## 每轮工作流

1. **先确认现状**（只读）：
   ```bash
   scripts/run-skill.sh <id> --dry-run     # 真实 loader 结构校验
   scripts/latest-run.sh 200               # 读最近的 transcript / 截图
   ```
2. **快照**：`scripts/snapshot-skill.sh <id> before-edit`
3. **跑一轮拿证据**：`scripts/loop.sh <id>`（默认可见浏览器）
4. **定位**：在 transcript 里找到最后一条 `result: "error"` 的 step，读它的 `errorMessage` 和失败截图。
5. **写最小补丁**：优先 `edit-step-prompt` / `insert-step` / `add-known-issue`；一次只改一处，便于归因。补丁是结构化 JSON（schema 见 `src/evolve/types.ts` 的 `skillPatchSchema`），不写代码。
6. **应用补丁 + 安装候选 + 复跑**：
   ```bash
   scripts/apply-patch.sh <id> patch.json     # 应用 + loader 校验，只在通过时写出候选
   scripts/candidate.sh <id> <candidate-path> # 安装为覆盖（会再校验一次）
   scripts/loop.sh <id>
   ```
7. **收敛**：成功 → `scripts/promote.sh <id>`；回归/无预算 → `scripts/rollback.sh <id>`

## 用 `giclaw evolve`（已落地）

上面的手工 harness 与 `giclaw evolve` 是同一套逻辑的两条驱动路径。整条链路已经实现，可以直接用：

```bash
giclaw evolve --skill <id> --dry-run          # 只诊断 + 提案 + 校验（用最近含该技能的真实运行）
giclaw evolve --skill <id>                    # 完整迭代，默认需人工确认
giclaw evolve --status                        # best-known-good / 待确认 / 最近代数
giclaw evolve --show <genId>
giclaw evolve --skill <id> --accept [--apply] # 接受（--apply 才写已提交目录）
giclaw evolve --skill <id> --reject           # 回滚到会话前状态
```

引擎在 `src/evolve/`：`engine.ts`（状态机）、`diagnose.ts` / `propose.ts`（模型读写）、`patch.ts` / `validate.ts` / `policy.ts`（补丁与硬门禁）、`budget.ts`、`evidence.ts`、`store.ts`、`model-client.ts`（OpenAI 兼容纯文本）、`command.ts`。

## 垂直切片（边开发边调试边执行）

**Slice 0 — 证据采集（今天可用，无需写代码）**
`run-skill.sh` + `latest-run.sh`。完成标准：任意技能都能稳定拿到 `lastRunId`、逐步 transcript、失败截图路径。

**Slice 1 — 快照 / 候选 / 回滚（今天可用）**
`snapshot-skill.sh` / `candidate.sh` / `promote.sh` / `rollback.sh` / `loop.sh`。完成标准：试错安全，仓库文件在 `promote` 前不变。

**Slice 2 — 结构化诊断（模型只读证据，不改文件）**
输入：SKILL.md 全文 + 最近 transcript + run summary。输出必须是可被 zod 校验的 JSON（schema 见 `references/design.md` 第 4 节）：失败 step、根因假设、置信度、`suggestedFixKind`。`no-safe-fix` 时直接停，不要硬改。完成标准：诊断稳定指向单一 step。

**Slice 3 — 补丁生成 + 校验（已落地：`src/evolve/**`）**
`patch.ts` 只允许 `insert-step` / `edit-step-prompt` / `reorder-step` / `add-known-issue` / `adjust-timeout`；`types.ts` 用 zod 定义诊断与补丁 schema；`policy.ts` 做红线检查；`validate.ts` 用真实 loader schema + body parser 在内存中校验。`scripts/apply-patch.sh` 只在通过校验时写出候选，`candidate.sh` 会再校验一次。完成标准：候选 100% 过 loader，diff 最小且只触及预期行。

**Slice 4 — 自动循环 + 预算 + 审批（已落地：`giclaw evolve`）**
状态机在 `src/evolve/engine.ts`：OBSERVE→DIAGNOSE→PROPOSE→VALIDATE→APPLY→RE-RUN→EVALUATE，通过 `Gateway.runOnce([id])` 复用真实管线，重跑前 `Gateway.reloadSkills()`；证据与记录写入 `~/.giclaw/evolve/generations/<genId>/`；默认需人工 `--accept`。完成标准：一条命令能从失败迭代到通过或预算耗尽，全程可回滚、可审计。

## Harness 脚本

所有脚本都支持 `--help`，输出遵循「stdout = 结构化结果，stderr = 诊断」。用相对路径从 skill 目录调用，例如 `scripts/loop.sh`。

| 脚本 | 作用 | 改文件？ | 启动浏览器？ |
|---|---|---|---|
| `scripts/run-skill.sh <id> --dry-run` | 真实 loader 结构校验 | 否 | 否 |
| `scripts/run-skill.sh <id>` | 跑单个技能并落日志 | 否 | 是 |
| `scripts/latest-run.sh [n]` | 结果 / transcript / 截图摘要 | 否 | 否 |
| `scripts/snapshot-skill.sh <id> [label] [source]` | 快照 SKILL.md | 否 | 否 |
| `scripts/candidate.sh <id> <file>` | 校验 + 安装候选覆盖 | 仅 `~/.giclaw` | 否 |
| `scripts/apply-patch.sh <id> <patch.json>` | 应用结构化补丁 + 离线校验，产出候选 | 仅 `~/.giclaw` | 否 |
| `scripts/loop.sh <id> [--dry-only]` | 快照→校验→真跑→摘要 | 仅 `~/.giclaw` | 默认是 |
| `scripts/promote.sh <id>` | 候选转正到仓库 | 是（唯一） | 否 |
| `scripts/rollback.sh <id> [snapshot]` | 移除候选覆盖；传快照才恢复仓库文件 | 仓库（仅显式快照时）+覆盖 | 否 |
| `scripts/validate-skill.ts <dir>` | 直接调用 giclaw loader | 否 | 否 |
| `scripts/self-check.sh` | 校验本 skill 自身结构 | 否 | 否 |

先跑 `--help`；不要读脚本源码，除非你确实要改它。

## Gotchas

这些是 giclaw 特有的坑，不知道就会浪费一整轮：

- **`giclaw run --dry-run` 仍然要求已配置模型**：`runOnce` 在 dry-run 分支之前就检查 `isModelConfigured`。只想做结构校验时，用 `scripts/candidate.sh` 或 `scripts/validate-skill.ts`，它们不碰模型。
- **覆盖优先级依赖配置顺序**：`tasks.skillsDirs` 后面的目录覆盖前面的，`~/.giclaw/skills` 默认在最后。若用户自定义了 `skillsDirs` 且去掉了这一项，`candidate.sh` 的覆盖不会生效——先 `cat ~/.giclaw/config.json` 确认。
- **技能 id 必须等于目录名**，且校验需要 `<dir>/<id>/SKILL.md` 布局。候选暂存目录必须保留这一层。
- **`retries` 只能是 `0`**（loader 用 `z.literal(0)` 强制）。UI 工作流一旦部分执行就没有可靠起点，不要试图"重试修复"。
- **`aiWaitFor` 单步上限 180s**，且会为清理保留 15s。遇到超时不要只调大 `timeoutMs`；先看失败的等待条件是否写得太死或地图/界面确实没到。
- **云游戏输入需要长按**（鼠标 ≥100ms、按键 ≥500ms），执行器已处理。不要"优化"成更短，否则云端会丢输入。
- **transcript 的 `runId` 是 UUID**，但 `state.json` 可能因持久化失败而缺失该次记录；以 `~/.giclaw/data/transcripts/*.jsonl` 为准。
- **截图是给人看的**：不要把 PNG 字节塞进纯文本诊断模型，只传路径用于人工核对。
- **快照有来源区别**：`snapshot-skill.sh` 默认快照**已提交的 repo 文件**（`source=repo`）；`candidate.sh` 只快照它要替换的 override；`rollback.sh` 默认只移除 override，**不会**拿任意快照覆盖仓库。这也意味着候选阶段回滚 = 移除 override，仓库从开始到 `promote` 都不会变。
- **候选重跑必须重新加载技能**：`Gateway` 在 `init()` 时把技能定义注册进 `TaskRunner`，只改文件不会生效。`giclaw evolve` 在每次重跑前调用 `gateway.reloadSkills()`；手工用 `run-skill.sh` 时每次都是新进程，天然重新加载。
- **`--dry-run` 是全局选项**：`giclaw evolve --dry-run` 仍然走 dry-run（命令同时读取全局与子命令选项），但不要在脚本里假设它只作用于 `run`。dry-run 不是「不访问模型」：它仍然需要模型来做诊断与提案，只是不启动浏览器。
- **`.agents/skills/giclaw-evolve` 不是 giclaw 的技能目录**，不要在 `skillsDirs` 里引用它（它的 frontmatter 是 Agent Skills 格式，不含 `## Steps`）。
- **`pnpm dev` = `tsx src/cli.ts`**；脚本统一用 `pnpm exec tsx src/cli.ts` 且 `cwd` 为仓库根，否则 `./skills` 解析不到。

## 工作区布局（`~/.giclaw/`，私有 0700）

```
skills/<id>/SKILL.md                    # 候选覆盖（最后加载，优先级最高）
evolve/
├── snapshots/<id>/<ts>-<label>/        # 改动前的不可变快照
├── candidates/<id>/<ts>/               # 手工候选存档
├── runs/<ts>-<id>.log                  # 手工运行的完整日志
├── generations/<genId>/record.json     # 每代诊断/补丁/校验/结果
├── generations/<genId>/candidate/      # 每代候选存档
├── pending/<skillId>.json              # 待人工确认 + 会话前覆盖内容
└── best-known-good/<skillId>.json      # 最近一次通过的代数
data/
├── transcripts/<runId>.jsonl           # giclaw 原生逐步记录
├── screenshots/*.png                   # 失败现场与检查点
└── state.json                          # 运行摘要（lastRunId/history）
```

## 实施阶段与完成标准

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| P0 | 证据采集（slice 0） | 任意技能可稳定取到 transcript + 截图 |
| P1 | 快照/候选/晋升/回滚（slice 1） | 试错安全，仓库在 promote 前不变 |
| P2 | 结构化诊断（slice 2） | 诊断稳定指向单个 step |
| P3 | `src/evolve/` 补丁 + 校验 + 单测（已落地） | 候选 100% 过 `loadSkills`，diff 最小 |
| P4 | `giclaw evolve` 自动循环 + 预算 + 审批（已落地） | 自动迭代可回滚、可审计、默认需审批 |

每个阶段收尾都要：`pnpm typecheck && pnpm lint:check && pnpm test`，再做一次真实可见浏览器验证。

## 安全红线

- 只允许调整 `Steps` / `Background` / `Goal` / `Known Issues` / 安全相关 frontmatter（如 `timeoutMs`）。
- 拒绝购买、消耗原石或付费货币、不可逆删除类改动；策略层要能挡住，而不是靠模型自觉。
- 截图、transcript、快照含账号信息：保持 0600/0700，不提交、不外发。
- 自动 `--apply` 默认关闭；先人工 `promote.sh` 观察。
- 真实云游戏涉及服务条款与账号风险；不确定时选择不改。

## 参考（按需加载）

- `references/design.md` — 要改 `src/evolve/**` 或理解数据模型/预算/策略时读。
- `references/integration-points.md` — 要接现有源码（`loader`、`Gateway`、`executeSteps` 等）时读。
- `assets/generation-record.example.json` — 要写 generation 记录时读。
- `evals/evals.json`、`evals/trigger-queries.json` — 要验证本 skill 行为/触发时读。
