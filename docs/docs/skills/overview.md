---
sidebar_position: 1
title: 技能概述
---

# 技能系统

技能是 giclaw 的任务单元。每个技能是一个 `SKILL.md` 文件，包含 YAML frontmatter（机器配置）和 Markdown 正文（AI 指令）。添加新技能只需写一个 Markdown 文件，无需编写 TypeScript 代码。

## 技能结构

```
skills/<skill-id>/SKILL.md
```

任务通过**文件驱动的技能系统**定义。每个技能是一个 `SKILL.md`——YAML frontmatter 定义配置，Markdown 正文定义 AI 指令。

## 内置技能

| ID | 名称 | 默认状态 | 真实账号验收 |
|----|------|----------|--------------|
| `welkin-moon` | 月卡每日领取 | 启用 | 已通过 |
| `claim-mail` | 邮件领取 | 启用 | 已通过 |
| `battle-pass-claim` | 纪行奖励领取 | 启用 | 已通过 |
| `claim-achievements` | 成就奖励领取 | 启用 | 已通过 |
| `claim-event-rewards` | 活动奖励领取 | 启用 | 已通过 |
| `expedition-collect` | 探索派遣收取与再次派遣 | 关闭 | 暂停，尚未完成真实闭环 |

所有技能按依赖展开后的顺序在同一浏览器会话中依次执行。`welkin-moon` 负责启动游戏，其他内置技能通过 `dependsOn` 声明此前置条件。5 个已通过真实账号验收的奖励任务默认全部启用；`daily` 可以只运行月卡和邮件。

探索派遣能力当前暂停，已从 `rewards`、`full` 和默认启用集合中移除；只有显式指定该任务时才会被选择。

使用 `giclaw skills` 查看当前目录实际加载的技能、步骤数、依赖、命名流程和全部原子操作。

## 共享上下文技能

除可运行任务外，`skills/` 下还有一组 `context: true` 的**上下文技能**（目前 16 个，覆盖 UI、地图、任务、战斗、角色养成、背包、商店、社交、活动、自动化陷阱等 13 个标签）。它们不会被执行，只把 `Background` 与 `Known Issues`（原神通用 UI 约定、云游戏页面结构、奖励语义、安全红线等）注入**声明了对应标签**的可运行技能：`core` 标签始终注入，其余由可运行技能的 `contexts` 选择。这样几百个知识技能也不会全部进入每次提示词。它们不出现在可运行任务目录里，也不能被 `giclaw evolve` 进化。完整清单见「上下文技能」页面。
