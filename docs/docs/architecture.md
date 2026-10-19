---
sidebar_position: 6
title: 架构
---

# 架构

## 当前真实执行链

```text
CLI / Cron / HTTP API
        │
        ▼
Gateway ──► FIFO Queue（CLI / daemon / API 共用）
        │
        ├─ 加载并严格校验 SKILL.md
        ├─ 递归展开 dependsOn，去重并排序
        ▼
SessionManager ──► Cookie 恢复 / 可见窗口人工登录
        │
        ▼
TaskRunner（顺序执行、取消、超时、失败即停）
        │
        ▼
StepExecutor
  ├─ AI 原子操作：Midscene 截图 + 视觉模型 + Playwright
  └─ 确定性操作：Playwright 键盘 / 鼠标 / 等待 / 截图
        │
        ├─ JSONL transcript
        ├─ 失败现场 PNG
        └─ state.json 运行摘要
```

项目不是一个自由循环直到模型返回 `done` 的通用 Agent。它执行 `SKILL.md` 中有界、可审计的 `## Steps` 工作流；其中 `aiAct` 可以在单个步骤内部让 Midscene 规划多个动作。

## 自我迭代回路

`giclaw evolve` 在同一个执行链之上叠加一层有界的进化回路：

```text
Gateway.getRunHistory ──► 证据（transcript / 截图 / run summary）
        │
        ▼
模型（纯文本）──► 结构化诊断 ──► 结构化补丁
        │
        ▼
validateSkillCandidate（复用 loader schema + 红线策略 + 行数上限）
        │
        ▼
EvolveStore 安装候选覆盖 ──► Gateway.reloadSkills() ──► 真实重跑
        │
        ▼
接受（待确认 / --apply）或回滚到会话前状态
```

进化只修改 `SKILL.md`，不生成或执行代码；候选重跑前必须 `reloadSkills()`，否则会继续使用启动时缓存的旧步骤定义。

## 关键语义

- `Background`、`Goal`、`Known Issues` 被注入 `aiActionContext`，为每个 AI 步骤提供共享约束。其中 `context: true` 的**上下文技能**（原神 UI 约定、云游戏页面、奖励语义、安全红线）的 `Background` 与 `Known Issues` 会先合并进每个可运行技能；上下文技能不执行、也不需要 Steps。
- `enabled` 是技能目录的推荐状态；真正的执行集合由 `tasks.enabled`、`--tasks` 或 `--routine` 决定。
- `dependsOn` 会自动加入前置技能。例如运行 `claim-mail` 会先运行 `welkin-moon`。
- 同一 ID 出现在多个 `skillsDirs` 时，后面的目录覆盖前面的目录，允许用户定制内置技能。
- 未知任务、空 Steps、未知原子操作、目录名与 ID 不一致、依赖环都会在启动或 dry-run 阶段失败。
- UI 工作流不做自动重试；任一技能失败都会停止整次运行，避免在未知界面继续操作。
- CLI、定时任务和 HTTP API 共享同一个有最大深度限制的串行 FIFO 队列，登录、浏览器操作、Cookie 与持久化不会并发重叠。
- 超时或关停会向登录、模型请求、等待和步骤执行传播取消信号；单个视觉等待最多占用 3 分钟，并为诊断与清理保留总预算。长等待每 15 秒上报一次进度，不响应取消的执行会在有限清理窗口后被隔离，后续任务不得继续启动。
- 任务执行全部完成即进入不可取消的提交阶段：必须先确认浏览器关闭，再记录并返回结果；此后到达的关停信号不会把已发生的领取误报为失败并诱导重复执行。
- 按键或鼠标长按会在成功、失败、超时和取消路径中对称释放。
- API Key、Cookie、transcript、截图和状态文件使用仅当前用户可读写的权限；日志与持久化记录会对常见凭据格式递归脱敏，Midscene 自带的未脱敏追加日志在本项目进程内关闭。

## 可验证边界

构建、单元测试和 dry-run 能证明配置、加载、依赖与编排层正常，但不能替代真实云游戏验收。当前已有 5 个奖励任务完成真实账号全流程验证，探索派遣暂停。账号、Cookie、云游戏排队、版本 UI、视觉模型和网络任一变化后，仍应使用可见模式进行针对性回归。
