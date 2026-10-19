# giclaw 自我迭代 Loop 进化系统 — 设计

> 本文件是 `giclaw-evolve` skill 的目标架构。它是「要建成什么」的规范；`SKILL.md` 是「怎么一步步建成」的操作手册。任何实现都必须服从 `SKILL.md` 的《核心不变量》。
>
> 状态：已实现。实际代码见 `src/evolve/`，CLI 见 `giclaw evolve`，配置见 `evolve` 段。下面与实际实现有出入处以代码为准。

## 1. 目标与非目标

### 目标

1. giclaw 能从**真实运行证据**（transcript、失败截图、run summary）出发，自动诊断自己某个 `SKILL.md` 的失败原因。
2. 自动产出**最小、可审计**的 `SKILL.md` 补丁，而不是任意代码。
3. 每个候选都经过严格 loader 校验 + 红线策略检查，并在真实浏览器里重跑。
4. 成功且无回归 → 晋升；失败/回归 → 自动回滚并记录。
5. 全程有界、可回滚、可追溯、默认需人工审批才写入仓库。

### 非目标

- 不生成或执行任意 TS/JS/shell 代码。
- 不改变确定性执行器语义（`src/agent/step-executor.ts` 的原子操作集合）。
- 不做多技能并发进化；沿用 giclaw 的串行 FIFO 队列。
- 不替代真实账号验收。

## 2. 数据模型

### GenerationRecord（`~/.giclaw/evolve/generations/<genId>/record.json`）

```jsonc
{
  "genId": "welkin-moon-20260807T120000Z-3", // skillId + 时间戳 + 序号
  "skillId": "welkin-moon",
  "parentGenId": "welkin-moon-20260807T115500Z-2", // 上一代，首代为 null
  "startedAt": "2026-08-07T12:00:00.000Z",
  "completedAt": "2026-08-07T12:04:31.000Z",
  "status": "accepted", // proposed | rejected-by-validate | rejected-by-policy | regressed | accepted | aborted-budget
  "trigger": "manual", // manual | cron | api
  "model": { "name": "gpt-4o", "baseUrl": "https://..." }, // 不含 apiKey
  "baseline": {
    "runId": "uuid",
    "success": false,
    "failedStep": 24,
    "message": "Step 24/35 (aiWaitFor) failed: ...",
    "durationMs": 421000
  },
  "diagnosis": {
    "failedStep": 24,
    "method": "aiWaitFor",
    "rootCauseHypothesis": "...",
    "confidence": 0.6,
    "suggestedFixKind": "insert-wait-before-step"
  },
  "patch": {
    "kind": "minimal", // minimal | insert-step | reorder-step | edit-text
    "touchedLines": { "from": 118, "to": 121 },
    "diff": "--- a/SKILL.md\n+++ b/SKILL.md\n@@ ...",
    "sha256Before": "…",
    "sha256After": "…"
  },
  "validation": { "loaderOk": true, "policyOk": true, "violations": [] },
  "candidate": {
    "runId": "uuid",
    "success": true,
    "failedStep": null,
    "message": "All steps completed",
    "durationMs": 338000
  },
  "artifacts": {
    "candidateSkill": "candidate/SKILL.md",
    "baselineTranscript": "evidence/baseline.jsonl",
    "baselineScreenshot": "evidence/baseline-failure.png",
    "candidateTranscript": "evidence/candidate.jsonl"
  }
}
```

字段全部经过 giclaw 既有 `sanitizeBoundedText` / `sanitizeSensitiveData` 处理；不落任何模型密钥。

### BestKnownGood（`~/.giclaw/evolve/best-known-good.json`）

```json
{
  "skills": {
    "welkin-moon": {
      "genId": "welkin-moon-20260807T120000Z-3",
      "skillSha256": "…",
      "snapshotDir": "snapshots/welkin-moon/20260807T120429Z-accepted",
      "acceptedAt": "2026-08-07T12:04:31.000Z",
      "baselineDurationMs": 421000,
      "candidateDurationMs": 338000
    }
  }
}
```

## 3. 循环状态机

```
IDLE
 └─(evolve --skill id)→ OBSERVED          运行基线，得到 evidence
        └→ DIAGNOSED                      模型只读证据，产出结构化诊断
             └→ PATCH_PROPOSED            产出 SKILL.md 最小补丁
                  ├→ VALIDATION_FAILED → REJECTED_VALIDATE → ROLLBACK
                  └→ VALIDATED
                       └→ APPLIED          安装为 ~/.giclaw/skills/<id> 覆盖
                            └→ RE_RUNNING
                                 ├→ SUCCEEDED  → EVALUATED
                                 └→ STILL_FAILING → EVALUATED
                                      └→ ACCEPTED → PROMOTE（或等待审批）
                                      └→ REGRESSED / BUDGET_EXHAUSTED → ROLLBACK
```

每一步都要落盘，进程崩溃后可从 `generations/<genId>/` 恢复。

## 4. 诊断接口（结构化输出）

诊断是一次**纯文本模型调用**（不截图、不带浏览器），输入：

- 当前 `SKILL.md` 全文（frontmatter + 正文）
- 最近的 `transcript.jsonl`（截断到最近 N 条）
- `baseline` run summary
- 若可用：失败截图路径（仅供人看，不传给纯文本模型）

输出必须是可被 zod 校验的 JSON：

```ts
const diagnosisSchema = z.object({
  failedStep: z.number().int().positive().nullable(),
  method: z.enum(STEP_METHODS).nullable(),
  rootCauseHypothesis: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  suggestedFixKind: z.enum([
    'insert-wait-before-step',
    'edit-step-prompt',
    'add-known-issue',
    'reorder-step',
    'adjust-timeout',
    'no-safe-fix',
  ]),
  reasoning: z.string().max(4000).optional(),
})
```

`suggestedFixKind === 'no-safe-fix'` 时不得继续提案，直接 `REJECTED`。

## 5. 补丁接口

补丁只允许以下操作，且必须保持 loader 可解析：

| kind | 说明 |
|---|---|
| `insert-step` | 在指定 step 前/后插入 1–2 个原子操作（如 `wait`、`aiWaitFor`） |
| `edit-step-prompt` | 改写某一步的自然语言参数 |
| `reorder-step` | 在安全范围内交换相邻步骤 |
| `add-known-issue` | 追加 `## Known Issues` 条目（只影响 AI 上下文） |
| `adjust-timeout` | 调整 frontmatter `timeoutMs`（有上限） |

强制约束：

- diff 行数上限（默认 40 行），超出即拒绝。
- 不允许改动 `id`；不允许新增 `dependsOn` 到未知技能；`retries` 必须仍为 `0`。
- 不允许把确定性操作改成会触发购买的 `aiAct`；策略层（第 7 节）做语义检查。
- 产出的候选必须能通过 `loadSkills`。

## 6. 预算与终止条件

```ts
interface EvolveBudget {
  maxGenerations: number   // 默认 3
  maxWallClockMs: number   // 默认 30 分钟
  maxModelCalls: number    // 默认 2 * maxGenerations + 4
  requireApproval: boolean // 默认 true
}
```

任一预算耗尽 → `aborted-budget`，保留 best-known-good，不回滚已验证失败的候选（必须回滚到 baseline）。

回归判定：候选 `success === true` 且 `durationMs <= baseline.durationMs * regressionFactor`（默认 `1.5`）；否则视为 `regressed`。

## 7. 策略层（红线）

在 `src/evolve/policy.ts` 中集中实现，先于任何运行执行：

- 禁止引入/保留：购买、消耗原石或付费货币、不可逆删除类步骤。
- 禁止 `dependsOn` 指向不存在或新增的外部技能。
- 禁止超过 `maxSteps`（默认 80）或 `maxTimeoutMs`（默认 15 分钟）。
- 命中红线 → `rejected-by-policy`，记录 `violations`，不运行。

策略以**关键词 + 步骤结构**双重检查：既看自然语言（如「原石」「购买」「确认支付」），也看方法组合（如 `aiAct` 参数包含确认类动词且上下文是商店）。

## 8. CLI 约定（已实现）

```
giclaw evolve --skill <id> [options]
  --max-generations <n>     覆盖 evolve.maxGenerations（默认 3）
  --max-minutes <n>         覆盖 evolve.maxWallClockMs（默认 30 分钟）
  --no-require-approval     覆盖 evolve.requireApproval，通过后自动接受
  --apply                   与 --accept 连用，写入已提交目录（默认 ./skills）
  --target-dir <dir>        指定 --apply 目标目录
  --dry-run                 只诊断 + 提案 + 校验，不启动浏览器（全局选项；仍需模型）
  --headless                覆盖浏览器可见性（全局选项）

giclaw evolve --status                      列出 best-known-good / 待确认 / 最近 generation
giclaw evolve --show <genId>                打印一条 generation 记录（JSON）
giclaw evolve --skill <id> --accept         接受该技能的待确认候选
giclaw evolve --skill <id> --reject         回滚到会话前的 override 状态
```

默认 `requireApproval: true`：候选通过后只留在 `~/.giclaw/skills/<id>/SKILL.md`（实时生效）并标记 pending，等待人工 `--accept` / `--reject`；`--apply` 才写入已提交目录。

## 9. Gateway / 编排接入

- 复用 `Gateway.runOnce([skillId])` 运行基线与候选，绝不新开浏览器路径。
- 复用 `TaskRunner` 的串行保证；进化运行同样进 FIFO 队列，与 daemon 的 cron 运行互斥。
- 证据读取 `config.memory.dataDir`（transcripts/screenshots）与 `StateStore` 的最近 `RunSummary`。
- 模型调用复用 `src/agent/streaming-openai-client.ts` 的 OpenAI 兼容客户端，但走**纯文本**模式（无截图），并复用取消信号。
- 新配置段（`src/config/schema.ts`）：

```ts
evolve: z.object({
  enabled: z.boolean().default(false),
  maxGenerations: z.number().int().positive().max(20).default(3),
  maxWallClockMs: z.number().int().positive().max(3_600_000).default(1_800_000),
  regressionFactor: z.number().min(1).max(5).default(1.5),
  requireApproval: z.boolean().default(true),
  maxPatchLines: z.number().int().positive().max(200).default(40),
  allowedSkills: z.array(z.string()).default([]), // 空 = 全部允许
}).default({})
```

## 10. 可观测性

- 每条 generation 记录即结构化日志，可用于统计成功率、平均代数、常见 `suggestedFixKind`。
- 后续在 Web 面板 / TUI 增加「进化历史」视图，展示 baseline vs candidate 的截图与 diff；本设计不改变现有面板契约，只新增只读数据源。
- 通知：可复用 `notifications` 的 `run:complete` / `run:error`，在进化结束时额外发 `evolve:accepted` / `evolve:rejected`（后续扩展）。

## 11. 失败模式与回滚矩阵

| 失败点 | 处理 |
|---|---|
| 诊断 JSON 不合法 | 重试 1 次；仍失败 → `rejected-by-validate`，保留 baseline |
| 提案产物 loader 失败 | 直接拒绝，不运行；记录 violations |
| 红线命中 | 直接拒绝，不运行 |
| 候选仍失败 | `still_failing`；若还没到预算，带入下一代继续诊断 |
| 候选成功但耗时回归 | `regressed`，回滚到 best-known-good |
| 浏览器/登录/超时 | 视为运行失败，回滚，不消耗模型预算之外的迭代 |
| 进程崩溃 | 从 `generations/<genId>/` 的落盘状态恢复；未完成候选一律回滚 |
| 预算耗尽 | 停在 best-known-good，输出 report |

## 12. 测试策略

- **纯函数优先**：诊断解析、patch 生成、policy 判定、回归判定全部可脱离浏览器单测。
- 复用仓库既有 vitest 结构，测试文件与被测文件同目录。
- 用 fixture SKILL.md + fixture transcript 构造失败场景，断言产出的候选通过 `loadSkills`。
- 端到端（真实浏览器）只在最后手动执行一次，作为验收；CI 不含真实账号。
