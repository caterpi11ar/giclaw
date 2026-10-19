# 接入点地图

本文件把 `references/design.md` 的架构对到仓库现有代码，给出**已有的导出**和**需要新增**的位置。实现前先读这些文件，不要另起炉灶。

## 已有能力（直接复用）

| 需求 | 文件 | 现有导出 / 入口 |
|---|---|---|
| 严格校验 SKILL.md | `src/skills/loader.ts` | `loadSkills(dirs)`；已导出 `parseSkillBody(markdown, sourcePath)` 与 `frontmatterSchema` 供内存校验复用 |
| 技能类型 / 原子操作表 | `src/skills/types.ts` | `SkillDefinition`、`SkillStep`、`StepMethod`、`STEP_METHODS` |
| 参数解析 | `src/skills/step-arguments.ts` | `parseDuration`、`parseCoordinates`、`parseArrowArgs`、`parseMouseButton`、`parseScrollSpec` |
| 注册与任务适配 | `src/skills/registry.ts` | `SkillRegistry.loadFromDirs` / `get` / `getAll` / `toTaskDefinitions` |
| 执行工作流 | `src/agent/step-executor.ts` | `executeSteps(ctx: StepContext): Promise<AgentResult>` |
| 执行上下文类型 | `src/agent/types.ts` | `StepContext`、`AgentResult` |
| 模型客户端（可复用为纯文本） | `src/agent/streaming-openai-client.ts` | `createStreamingOpenAIClient`、`createAbortableOpenAIClient` |
| 串行任务执行 / 事件 | `src/tasks/task-runner.ts` | `TaskRunner`：`register`、`registerAll`、`runAll`、`getEnabledTasks`、事件 `task:start/task:complete/run:complete/quarantine` |
| 运行入口（含登录/队列/持久化） | `src/gateway/gateway.ts` | `Gateway.runOnce(taskIds?)`、`enqueueRun(trigger, taskIds?)`、`getRunHistory(limit?)`、`init()`、`getTaskRunner()` |
| 运行摘要持久化 | `src/memory/state-store.ts` | `StateStore.getHistory(limit?)`（内部经 `updateAfterRun`） |
| transcript 读写 | `src/memory/transcript.ts` | `TranscriptWriter`（写入 `<dataDir>/transcripts/<runId>.jsonl`） |
| 证据类型 | `src/memory/types.ts` | `TranscriptEntry`、`RunSummary`、`PersistedState` |
| 私有文件 / 目录 | `src/config/paths.ts` | `PATHS`、`ensurePrivateDir`、`atomicWritePrivateFile`、`appendPrivateFile`、`PRIVATE_FILE_MODE` |
| 配置 schema / 加载 | `src/config/schema.ts`、`src/config/loader.ts` | `appConfigSchema`、`loadConfig`、`getConfig` |
| 错误类型 | `src/utils/errors.ts` | `AppError`、`ConfigError`、`TaskError`、`StepExecutionError`、`TimeoutError`、`toError` |
| 脱敏 / 有界文本 | `src/utils/logger.ts` | `logger`、`sanitizeBoundedText`、`sanitizeSensitiveData` |
| CLI 命令注册 | `src/cli.ts` | commander `program`（在文件末尾追加 `.command(...)`） |

## 需要新增

```
src/evolve/
├── types.ts          # ✅ 诊断/补丁/预算/策略/generation/pending/BKG schema
├── patch.ts          # ✅ 结构化补丁应用（line-level，最小 diff）
├── policy.ts         # ✅ 红线策略层（关键词 + 结构）
├── validate.ts       # ✅ 内存校验：真实 loader schema + policy
├── diagnose.ts       # ✅ 诊断 prompt 构造 + 解析（注入式 call）
├── propose.ts        # ✅ 提案 prompt 构造 + 解析
├── json.ts           # ✅ 无回溯的 JSON 提取/解析
├── diff.ts           # ✅ 最小 diff 摘要
├── budget.ts         # ✅ 预算与回归判定
├── evidence.ts       # ✅ 从 dataDir 收集 transcript / 截图 / run summary
├── store.ts          # ✅ ~/.giclaw/evolve/** 与 override 读写（私有文件）
├── model-client.ts   # ✅ OpenAI 兼容纯文本调用（fetch，带超时）
├── engine.ts         # ✅ 状态机 OBSERVE→…→ACCEPTED/ROLLBACK（依赖注入，可测）
├── command.ts        # ✅ `giclaw evolve` 入口 + accept/reject/status/show
└── index.ts          # ✅ 对外导出
```

## Gateway / Web 新增能力

| 能力 | 位置 | 说明 |
|---|---|---|
| `Gateway.reloadSkills()` | `src/gateway/gateway.ts` | 从磁盘重读 `skillsDirs` 并重建 `TaskRunner`；候选覆盖安装后必须调用，否则重跑仍用启动时缓存 |
| `Gateway.getSkillDefinition(id)` | 同上 | 返回已加载的 `SkillDefinition`（含 `sourcePath`），供读取当前 `SKILL.md` |
| `GET /api/evolve` | `src/web/api.ts` | 只读：`{ bestKnownGood, pending, generations }` |
| `GET /api/evolve/:genId` | 同上 | 单条 generation 记录，未知返回 404 |

## 已接入的配置/CLI

- `src/config/schema.ts` 已增加 `evolve` 段（默认 `enabled: false`）。
- `src/cli.ts` 已注册 `program.command('evolve')`，处理函数在 `src/evolve/command.ts`。
- `registerApi(app, gateway, plugins?, evolveStore?)` 支持注入 `EvolveStore` 以便测试。

## 证据读取约定

- `runId` 来源：`StateStore.getHistory(1)[0].runId` 或 `gateway.runOnce()` 之前记录的 `Date.now()` 附近。
- transcript：`<memory.dataDir>/transcripts/<runId>.jsonl`，每行一个 `TranscriptEntry`。
- 截图：`<memory.dataDir>/screenshots/`，失败步骤命名形如 `<skillId>-step-<n>-failure.png`。
- 不要把 `screenshots/` 的 PNG 传给纯文本诊断模型；只把路径写进 generation 记录供人查看。

## 安全复用清单

- 写任何文件都用 `atomicWritePrivateFile` / `ensurePrivateDir`，不要用裸 `writeFile`。
- 所有进入日志/记录的字符串先过 `sanitizeBoundedText` / `sanitizeSensitiveData`。
- 模型密钥只从 `config.model` 读取并转成 `MIDSCENE_MODEL_*` 时的同样引用方式；generation 记录里只存 `name`/`baseUrl`。
- 浏览器运行一律通过 `Gateway`，不要直接 `new SessionManager`。

## 验证命令

```bash
pnpm typecheck
pnpm lint:check
pnpm test
# 单技能结构校验（本 skill）
.agents/skills/giclaw-evolve/scripts/run-skill.sh <id> --dry-run
# 真实可见浏览器验收
.agents/skills/giclaw-evolve/scripts/loop.sh <id>
```
