---
sidebar_position: 4
title: 上下文技能
---

# 上下文技能（共享游戏知识）

`context: true` 的技能**不会被执行**，只把 `Background` 与 `Known Issues` 注入可运行技能的 AI 上下文，让视觉模型在每一步都理解原神。

为避免技能数量增长后全部进入每次提示词，注入是**按标签**的：上下文技能声明 `tags`，可运行技能声明 `contexts`，`core` 标签始终注入。

当前共 **16** 个上下文技能，覆盖 **13** 个标签。

## 可运行技能请求的标签

| 技能 | contexts |
|---|---|
| `battle-pass-claim` | `ui`, `reward` |
| `claim-achievements` | `ui`, `reward` |
| `claim-event-rewards` | `ui`, `reward`, `event` |
| `claim-mail` | `ui`, `reward` |
| `expedition-collect` | `ui`, `reward`, `navigation` |
| `welkin-moon` | `ui` |

## 标签分组

### `core` — 核心（始终注入）

| 技能 | 说明 |
|---|---|
| `genshin-automation-pitfalls` | Genshin Automation Pitfalls |
| `genshin-basics` | Genshin Impact Basics |
| `genshin-cloud` | Cloud Gaming Chrome |
| `genshin-interaction-safety` | Genshin Interaction Safety |

### `ui` — 界面 UI

| 技能 | 说明 |
|---|---|
| `genshin-ui` | Genshin UI Screens |

### `map` — 地图与探索

| 技能 | 说明 |
|---|---|
| `genshin-map` | Genshin Map and Exploration |

### `quest` — 任务

| 技能 | 说明 |
|---|---|
| `genshin-quests` | Genshin Quests |

### `character` — 角色养成

| 技能 | 说明 |
|---|---|
| `genshin-characters` | Genshin Characters |

### `combat` — 战斗

| 技能 | 说明 |
|---|---|
| `genshin-combat` | Genshin Combat |

### `inventory` — 背包与物品

| 技能 | 说明 |
|---|---|
| `genshin-gear` | Genshin Inventory and Gear |

### `progression` — 成长与体力

| 技能 | 说明 |
|---|---|
| `genshin-progression` | Genshin Progression and Resin |

### `reward` — 奖励领取

| 技能 | 说明 |
|---|---|
| `genshin-rewards` | Genshin Reward Claiming |

### `shop` — 商店与消费

| 技能 | 说明 |
|---|---|
| `genshin-shop` | Genshin Shop and Spending |

### `social` — 社交

| 技能 | 说明 |
|---|---|
| `genshin-social` | Genshin Social |

### `event` — 活动

| 技能 | 说明 |
|---|---|
| `genshin-events` | Genshin Events |

### `navigation` — 移动与交互

| 技能 | 说明 |
|---|---|
| `genshin-navigation` | Genshin Navigation and Input |

## 编写

见[编写技能](./writing-skills.md)的 `context` / `tags` / `contexts` 字段。
