---
sidebar_position: 2
title: 编写技能
---

# 编写技能

每个技能位于 `skills/<skill-id>/SKILL.md`。启动和 `giclaw skills` / `--dry-run` 时会严格校验：未知原子操作、空步骤、错误 ID、无效依赖都会直接报错，不能再以“零步骤成功”掩盖配置问题。

## 完整格式

```markdown
---
id: my-skill
name: My Skill
description: One-line description for logs and API.
enabled: false
timeoutMs: 300000
retries: 0
dependsOn:
  - welkin-moon
---

## Background
告诉视觉模型当前场景和 UI 约束。

## Goal
描述整个技能的目标和安全边界。

## Steps
- keyPress: Escape
- aiWaitFor: 派蒙菜单已经打开
- aiTap: 邮件图标
- screenshot: mailbox-opened

## Known Issues
- 云游戏平台侧边栏不是游戏 UI，不要点击屏幕最左侧边缘。
```

`Background`、`Goal` 和 `Known Issues` 会作为 Midscene 的 `aiActionContext` 注入所有视觉 AI 步骤，不只是保存为元数据；其中 `Background` 与 `Known Issues` 还会先叠加所有**上下文技能**（`context: true`）的内容——这是共享游戏知识（原神 UI 约定、云游戏页面、奖励语义、安全边界）的注入方式。上下文技能不会作为任务运行，也不需要 `## Steps`。

## Frontmatter

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `id` | 必填 | kebab-case，必须与目录名一致 |
| `name` | 必填 | 显示名 |
| `description` | 必填 | 日志/API 简述 |
| `enabled` | `true` | 目录中的默认推荐状态；显式配置或 routine 仍可选择 `false` 技能 |
| `context` | `false` | 设为 `true` 表示「上下文技能」：不执行，只把 Background / Known Issues 注入可运行技能 |
| `tags` | `[]` | 仅上下文技能：归属标签；`core` 始终注入，空表示 `core` |
| `contexts` | `[]` | 仅可运行技能：要注入的上下文标签（`core` 总是包含） |
| `timeoutMs` | `600000` | 每次尝试的超时 |
| `retries` | `0` | 目前固定为 `0`；部分执行后的 UI 状态不可靠，禁止自动从头重放 |
| `dependsOn` | `[]` | 前置技能 ID；运行时自动递归加入、去重和拓扑排序 |

## 原子操作

### 视觉 AI（10 个）

| 操作 | 参数格式 | 用途 |
|---|---|---|
| `aiAct` | 自然语言任务 | 让模型规划并执行一组动作 |
| `aiTap` | 元素描述 | 视觉定位并左键点击 |
| `aiRightClick` | 元素描述 | 视觉定位并右键点击 |
| `aiHover` | 元素描述 | 视觉定位并悬停 |
| `aiInput` | `文本 => 输入框描述` | 定位输入框并输入 |
| `aiKeyboardPress` | `按键 => 可选目标描述` | AI 辅助按键 |
| `aiScroll` | `方向 [距离] => 可选区域描述` | AI 辅助滚动 |
| `aiWaitFor` | 状态描述 | 循环观察直到状态成立 |
| `aiAssert` | 断言描述 | 断言不成立时让步骤失败 |
| `aiBoolean` | 问题 | 返回布尔观察结果并写入 transcript |

### 确定性键鼠与诊断（12 个）

| 操作 | 参数示例 | 用途 |
|---|---|---|
| `click` | `640,360` | 精确左键点击 |
| `rightClick` | `640,360` | 精确右键点击 |
| `move` | `640,360` | 移动鼠标 |
| `scroll` | `down 500` | 精确滚轮输入 |
| `type` | `hello` | 键盘输入文本 |
| `keyPress` | `Escape` | 按下并释放按键 |
| `keyDown` / `keyUp` | `W` | 长按/释放按键，可用于宏或移动 |
| `mouseDown` / `mouseUp` | `left` | 长按/释放鼠标键 |
| `wait` | `1500` 或 `1.5s` | 确定性等待 |
| `screenshot` | `checkpoint-name` | 保存命名检查点截图 |

确定性操作适合稳定 UI 和键鼠录制回放；视觉操作适合版本变化、布局不确定的界面。混合使用通常比全程 `aiAct` 更快、更便宜，也更容易排错。

## 验证与运行

```bash
giclaw skills
giclaw run --dry-run --tasks my-skill
giclaw run --no-headless --tasks my-skill
```

`--dry-run` 只做本地结构与依赖验证，不会调用模型。实际运行失败时，transcript 会记录每一步，失败步骤会自动保存现场截图，并立即停止本次运行；确认现场后再手动重新启动。
