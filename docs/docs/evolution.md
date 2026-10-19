---
sidebar_position: 8
title: 自我迭代与进化
---

# 自我迭代与进化

giclaw 的技能是文件驱动的 `SKILL.md`，版本更新、UI 变化或视觉模型波动都会让某一步骤失效。**进化系统**让 giclaw 基于**真实运行证据**发现失败、提出对 `SKILL.md` 的最小修正、在真实浏览器里重跑验证，并在成功时保留、失败时回滚。

> 状态：已实现（CLI 命令 `giclaw evolve` + 诊断/补丁/校验/回滚引擎 + 只读 Web API）。默认**需要人工确认**才把候选写入已提交目录。开发过程由仓库内的 `giclaw-evolve` agent skill 驱动（`.agents/skills/giclaw-evolve/SKILL.md`）。

## 进化循环

```text
OBSERVE   运行技能（或读取最近一次运行），收集 transcript + 失败截图 + run summary
   ▼
DIAGNOSE  模型只读证据，输出结构化诊断（失败步骤 / 根因 / 置信度 / 修复类型）
   ▼
PROPOSE   生成对 SKILL.md 的**一处**最小结构化补丁
   ▼
VALIDATE  loadSkills 严格校验 + 红线策略 + 补丁行数上限（硬门禁，不过就不运行）
   ▼
APPLY     安装为候选覆盖 ~/.giclaw/skills/<id>/SKILL.md
   ▼
RE-RUN    真实浏览器重跑
   ▼
EVALUATE  成功且无回归 → 保留（待确认）；失败/回归 → 回滚
   └──────────────► 直到成功或预算耗尽
```

## 快速开始

```bash
# 1. 在 ~/.giclaw/config.json 中启用（可选；显式调用 giclaw evolve 不受此限制）
#    "evolve": { "enabled": true, "requireApproval": true }

# 2. 只诊断 + 提案 + 校验，不启动浏览器
giclaw evolve --skill claim-achievements --dry-run

# 3. 完整迭代（会真实运行，默认需要人工确认）
giclaw evolve --skill claim-achievements

# 4. 查看与确认
giclaw evolve --status
giclaw evolve --show <genId>
giclaw evolve --skill claim-achievements --accept          # 接受候选
giclaw evolve --skill claim-achievements --accept --apply  # 并写入已提交目录 ./skills
giclaw evolve --skill claim-achievements --reject          # 回滚到会话前状态
```

## CLI 参考

| 选项 | 说明 |
|---|---|
| `--skill <id>` | 要进化的技能（accept/reject 时也用它定位待确认候选） |
| `--status` | 列出 best-known-good、待确认候选与最近 generation |
| `--show <genId>` | 打印一条 generation 记录（JSON） |
| `--accept` / `--reject` | 接受 / 回滚 `--skill` 的待确认候选 |
| `--apply` | 与 `--accept` 连用，把候选复制到已提交目录（默认 `./skills`，否则 `~/.giclaw/skills`） |
| `--target-dir <dir>` | 指定 `--apply` 的目标目录 |
| `--max-generations <n>` | 覆盖 `evolve.maxGenerations` |
| `--max-minutes <n>` | 覆盖 `evolve.maxWallClockMs` |
| `--no-require-approval` | 通过后自动接受（仍需显式 `--apply` 才写已提交目录） |
| `--dry-run` | 只诊断 + 提案 + 校验，不启动浏览器（使用最近一次含该技能的真实运行作为证据） |

## 配置

```json
{
  "evolve": {
    "enabled": false,
    "maxGenerations": 3,
    "maxWallClockMs": 1800000,
    "maxModelCalls": 10,
    "regressionFactor": 1.5,
    "requireApproval": true,
    "maxPatchLines": 40,
    "modelTimeoutMs": 120000,
    "allowedSkills": []
  }
}
```

- `enabled` 默认 `false`，与插件系统一致：不自动运行。
- `regressionFactor`：候选成功但耗时超过基线 × 该系数即视为回归并回滚。
- `allowedSkills`：为空表示所有技能都可进化。
- 诊断/提案复用 `model` 配置（纯文本调用，不传截图）。

## 安全边界

- 只允许修改 `SKILL.md`，**不生成、不执行任意代码**。补丁是封闭集合：`insert-step` / `edit-step-prompt` / `reorder-step` / `add-known-issue` / `adjust-timeout`。
- 补丁先过 `loadSkills` 严格校验 + 红线策略（禁购买、消耗原石/付费货币、不可逆操作）+ 行数上限，不通过就不进入浏览器。
- 一次只进化一个技能，复用 giclaw 的串行 FIFO 队列；候选重跑前会重新从磁盘加载技能定义。
- 有界：代数、墙钟、模型调用、补丁行数都有上限。
- 任何非接受结局都会把 `~/.giclaw/skills/<id>/SKILL.md` 恢复到会话前状态；已提交目录在 `--apply` 之前不会被改写。
- 真实账号验收不可省略：dry-run 与单测只证明结构正确。

## 数据布局

```text
~/.giclaw/
├── skills/<id>/SKILL.md                 # 实时候选覆盖（优先级最高）
└── evolve/
    ├── generations/<genId>/
    │   ├── record.json                  # 该代诊断 / 补丁 / 校验 / 结果
    │   └── candidate/SKILL.md           # 候选存档
    ├── pending/<skillId>.json           # 待人工确认的候选 + 会话前覆盖内容
    └── best-known-good/<skillId>.json   # 每个技能最近一次通过的代数
```

## 只读 Web API

daemon / Web 面板启动后：

- `GET /api/evolve` → `{ bestKnownGood, pending, generations }`
- `GET /api/evolve/:genId` → 单条 generation 记录（未知返回 404）

## 开发工作流（本仓库）

在引擎开发或手工调试某个技能时，使用仓库内 agent skill 提供的安全 harness（`--help` 查看用法）：

```bash
S=.agents/skills/giclaw-evolve/scripts
$S/self-check.sh                        # 校验本 skill 自身结构
$S/run-skill.sh <id> --dry-run          # 结构校验
$S/loop.sh <id>                         # 快照 → 校验 → 真跑 → 证据摘要
$S/apply-patch.sh <id> patch.json       # 应用结构化补丁 + 离线校验
$S/candidate.sh <id> <候选路径>          # 校验并安装候选
$S/promote.sh / rollback.sh             # 接受 / 回滚
```

完整设计见 `.agents/skills/giclaw-evolve/references/design.md`，与源码的接入点见同目录 `integration-points.md`。
