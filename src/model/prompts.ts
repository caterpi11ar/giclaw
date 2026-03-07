/**
 * All prompt templates used by the vision model.
 * Pure functions — no side effects, no dependencies.
 */

import type { Locale, RecentAction, TaskDescription } from './types.js'

type L = Record<Locale, string>
const t = (texts: L, locale: Locale): string => texts[locale]

export function findCoordinatesPrompt(goal: string, locale: Locale): string {
  return [
    t({ zh: `我的目标是：${goal}`, en: `My goal is: ${goal}` }, locale),
    t({
      zh: `请分析这张截图，找到我应该点击的交互元素（如按钮、链接、图标等），`,
      en: `Please analyze this screenshot and find the interactive element I should click (such as a button, link, icon, etc.), `,
    }, locale),
    t({
      zh: `返回该元素中心点的坐标，格式为纯 JSON: {"x": <number>, "y": <number>}。`,
      en: `return the coordinates of the element's center point as pure JSON: {"x": <number>, "y": <number>}.`,
    }, locale),
    t({
      zh: `坐标使用 0-999 的归一化坐标系（x 和 y 各 0-999），系统会自动转换为实际像素。`,
      en: `Use a 0-999 normalized coordinate system (x and y each 0-999); the system will automatically convert to actual pixels.`,
    }, locale),
    t({
      zh: `如果截图中没有可以完成该目标的交互元素，返回 {"x": -1, "y": -1}。`,
      en: `If there is no interactive element in the screenshot that can accomplish this goal, return {"x": -1, "y": -1}.`,
    }, locale),
    t({
      zh: `只返回 JSON，不要任何其他文字或 markdown。`,
      en: `Return only JSON, no other text or markdown.`,
    }, locale),
  ].join('')
}

export function checkConditionPrompt(condition: string, locale: Locale): string {
  return t({
    zh: `查看这张截图，判断以下条件是否成立："${condition}"。只回答 true 或 false，不要其他文字。`,
    en: `Look at this screenshot and determine whether the following condition is met: "${condition}". Answer only true or false, no other text.`,
  }, locale)
}

/**
 * Shared game context injected before every TaskDescription prompt.
 * Keeps SKILL.md files focused on task-specific info only.
 */
function gameContext(locale: Locale): string {
  return t({
    zh: `【原神游戏通用操控规则】
- **主界面（游戏世界画面）**：鼠标被锁定用于控制视角，**不能点击任何 HUD 元素**。只能通过**键盘按键**（如 Esc）进行交互。
- **菜单/弹窗界面**（派蒙菜单、邮箱、纪行等）：鼠标解锁，**可以正常点击**按钮和图标。

【屏幕左侧两列图标的区分——极其重要！】
屏幕左侧存在**两列不同的图标**，从左到右依次为：

第一列：**云游戏平台侧边栏**（x ≈ 0-25，紧贴屏幕最左边缘）
- 这些**不是游戏 UI**，**绝对不要点击**！点击会弹出浮层遮挡游戏。
- 如果误点弹出浮层，按 Escape 或点击浮层外区域关闭。

第二列：**派蒙菜单左侧图标栏**（x ≈ 35-65，在云游戏侧边栏的右侧）
- 仅在**派蒙菜单打开时**可见，是游戏内菜单的一部分。
- 包含 4-5 个小方形图标，纵向排列，间距较小。
- 从上到下依次为：角色头像（圆形）、好友（双人形）、**邮件（信封形）**、反馈（感叹号形）。
- **识别邮件图标的方法**：找到信封/书信形状的图标，它上方是圆形头像和双人图标，有新邮件时右上角有红色小圆点。

【主界面 HUD 布局】（仅供识别画面状态，不可点击）
- 左上角：派蒙头像图标（白色Q版角色头像）。
- 派蒙右侧：一排小功能图标（指南针N、相机、导航等）。
- 左上区域：圆形小地图，显示周围环境和方向。
- 右上角：一排菜单快捷图标，从左到右依次包括纪行、祈愿等入口。
- 右侧：队伍角色列表，显示 4 名角色头像和编号。
- 底部中央：角色等级和血条。
- 底部右侧：E（元素战技）和 Q（元素爆发）技能按钮。

`,
    en: `[Genshin Impact General Controls]
- **Main world screen**: Mouse is locked for camera control. **Cannot click any HUD elements**. Use **keyboard keys** (e.g., Esc) to interact.
- **Menu/popup screens** (Paimon menu, mailbox, battle pass, etc.): Mouse is unlocked. **Can click** buttons and icons normally.

[Two Icon Columns on the Left Side — CRITICAL DISTINCTION!]
There are **two separate columns of icons** on the left side of the screen, from left to right:

Column 1: **Cloud Gaming Platform Sidebar** (x ≈ 0-25, flush with the left screen edge)
- These are **NOT game UI**. **NEVER click them!** Clicking opens an overlay that blocks the game.
- If accidentally clicked, press Escape or click outside the overlay to close it.

Column 2: **Paimon Menu Left Icon Bar** (x ≈ 35-65, to the right of the cloud sidebar)
- Only visible when the **Paimon menu is open**; it is part of the in-game menu.
- Contains 4-5 small square icons arranged vertically with small spacing.
- From top to bottom: character avatar (circular), friends (two-person shape), **mail (envelope shape)**, feedback (exclamation mark shape).
- **How to identify the mail icon**: Look for the envelope/letter-shaped icon. Above it are the circular avatar and two-person icons. When there is new mail, a red dot appears at its top-right corner.

[Main Screen HUD Layout] (for visual identification only, not clickable)
- Top-left: Paimon avatar icon (white chibi character).
- Right of Paimon: Row of small utility icons (compass N, camera, navigation, etc.).
- Upper-left area: Circular minimap showing surroundings and direction.
- Top-right: Row of menu shortcut icons (battle pass, wishes, etc.).
- Right side: Party character list (4 character avatars with numbers).
- Bottom center: Character level and HP bar.
- Bottom right: E (Elemental Skill) and Q (Elemental Burst) buttons.

`,
  }, locale)
}

export function planNextActionPrompt(
  goal: string | TaskDescription,
  recentActions: RecentAction[] | undefined,
  locale: Locale,
): string {
  const parts: string[] = []

  // Goal section: structured or plain string
  if (typeof goal === 'string') {
    parts.push(t({
      zh: `你正在帮我完成以下任务：${goal}\n\n`,
      en: `You are helping me complete the following task: ${goal}\n\n`,
    }, locale))
    parts.push(t({
      zh: `请分析这张截图，判断当前状态，并决定下一步操作。\n\n`,
      en: `Please analyze this screenshot, assess the current state, and decide the next action.\n\n`,
    }, locale))
  }
  else {
    parts.push(gameContext(locale))
    parts.push(t({
      zh: `【任务背景】\n${goal.background}\n\n`,
      en: `[Task Background]\n${goal.background}\n\n`,
    }, locale))
    parts.push(t({
      zh: `【任务目标】\n${goal.goal}\n\n`,
      en: `[Task Goal]\n${goal.goal}\n\n`,
    }, locale))
    parts.push(t({
      zh: `请分析截图，判断当前状态，决定下一步。\n\n`,
      en: `Please analyze the screenshot, assess the current state, and decide the next step.\n\n`,
    }, locale))

    if (goal.knownIssues.length > 0) {
      parts.push(t({
        zh: `【已知问题及处理方法】\n`,
        en: `[Known Issues and Solutions]\n`,
      }, locale))
      goal.knownIssues.forEach((issue, i) => {
        parts.push(`  ${i + 1}. ${issue}\n`)
      })
      parts.push(`\n`)
    }
  }

  // Common sections
  parts.push(
    t({ zh: `【画面信息】\n`, en: `[Screen Information]\n` }, locale),
    t({
      zh: `- 坐标系：使用 0-999 的归一化坐标（x 和 y 各 0-999），系统会自动转换为实际像素\n`,
      en: `- Coordinate system: uses 0-999 normalized coordinates (x and y each 0-999); the system converts to actual pixels automatically\n`,
    }, locale),
    t({
      zh: `- 截图显示的是完整视口内容\n\n`,
      en: `- The screenshot shows the full viewport content\n\n`,
    }, locale),
    t({ zh: `【坐标精度要求】\n`, en: `[Coordinate Precision Requirements]\n` }, locale),
    t({
      zh: `- 你必须返回目标元素的精确中心点坐标，不是弹窗的中心，而是你想点击的那个具体按钮/图标的中心。\n`,
      en: `- You must return the exact center coordinates of the target element — not the center of the popup, but the center of the specific button/icon you want to click.\n`,
    }, locale),
    t({
      zh: `- 关闭按钮（×）通常是小图标，紧贴弹窗矩形右上角。先目测弹窗的右边界和上边界，关闭按钮就在那个角上。\n`,
      en: `- Close buttons (×) are usually small icons right at the top-right corner of the popup rectangle. First visually locate the right and top edges of the popup; the close button is at that corner.\n`,
    }, locale),
    t({
      zh: `- 对于普通按钮，坐标应在按钮文字的正中心。\n\n`,
      en: `- For regular buttons, the coordinates should be at the exact center of the button text.\n\n`,
    }, locale),
    t({ zh: `【弹窗处理策略】\n`, en: `[Popup Handling Strategy]\n` }, locale),
    t({
      zh: `如果截图中出现弹窗/对话框/引导窗口：\n`,
      en: `If a popup/dialog/guide window appears in the screenshot:\n`,
    }, locale),
    t({
      zh: `1. 首先精确定位关闭按钮（×）——它在弹窗矩形右上角\n`,
      en: `1. First precisely locate the close button (×) — it's at the top-right corner of the popup rectangle\n`,
    }, locale),
    t({
      zh: `2. 如果找不到关闭按钮，尝试点击弹窗内的确认/知道了/已了解按钮\n`,
      en: `2. If you can't find the close button, try clicking a confirm/OK/Got it button inside the popup\n`,
    }, locale),
    t({
      zh: `3. 如果都不行，按 Escape 键：{"action": "press-key", "key": "Escape"}\n`,
      en: `3. If neither works, press the Escape key: {"action": "press-key", "key": "Escape"}\n`,
    }, locale),
    t({
      zh: `4. 如果 Escape 无效，点击弹窗外部的空白区域（如屏幕角落 (8, 8) 或 (992, 8)）\n`,
      en: `4. If Escape doesn't work, click an empty area outside the popup (e.g., screen corner (8, 8) or (992, 8))\n`,
    }, locale),
    t({
      zh: `5. 绝对不要反复点击弹窗内容区域的中心——那里通常没有可交互元素\n\n`,
      en: `5. Never repeatedly click the center of the popup content area — there are usually no interactive elements there\n\n`,
    }, locale),
  )

  // Recent action history
  if (recentActions && recentActions.length > 0) {
    parts.push(t({
      zh: `【最近操作记录】（最近 ${recentActions.length} 步）\n`,
      en: `[Recent Actions] (last ${recentActions.length} steps)\n`,
    }, locale))
    for (const a of recentActions) {
      if (a.action === 'click') {
        parts.push(t({
          zh: `  步骤${a.step}: click (${a.x}, ${a.y}) — ${a.reason}\n`,
          en: `  Step ${a.step}: click (${a.x}, ${a.y}) — ${a.reason}\n`,
        }, locale))
      }
      else if (a.action === 'press-key') {
        parts.push(t({
          zh: `  步骤${a.step}: press-key "${a.key}" — ${a.reason}\n`,
          en: `  Step ${a.step}: press-key "${a.key}" — ${a.reason}\n`,
        }, locale))
      }
      else {
        parts.push(t({
          zh: `  步骤${a.step}: ${a.action} — ${a.reason}\n`,
          en: `  Step ${a.step}: ${a.action} — ${a.reason}\n`,
        }, locale))
      }
    }

    // Detect repeated clicks at similar coordinates
    const clicks = recentActions.filter(
      a => a.action === 'click' && a.x != null && a.y != null,
    )
    if (clicks.length >= 3) {
      const last = clicks.at(-1)!
      const allNear = clicks.every(
        c => Math.abs(c.x! - last.x!) <= 30 && Math.abs(c.y! - last.y!) <= 30,
      )
      if (allNear) {
        parts.push(
          t({
            zh: `\n⚠️ 【警告：重复点击同一位置！】\n`,
            en: `\n⚠️ [WARNING: Repeated clicks at the same position!]\n`,
          }, locale),
          t({
            zh: `你已经连续 ${clicks.length} 次点击坐标 (${last.x}, ${last.y}) 附近，但页面毫无变化。\n`,
            en: `You have clicked near coordinates (${last.x}, ${last.y}) ${clicks.length} consecutive times with no change on the page.\n`,
          }, locale),
          t({
            zh: `说明这个坐标不是可交互元素（很可能是弹窗的内容区域而非按钮）。\n`,
            en: `This indicates the coordinates are not an interactive element (likely the popup content area, not a button).\n`,
          }, locale),
          t({
            zh: `你现在必须选择一个完全不同的操作：\n`,
            en: `You must now choose a completely different action:\n`,
          }, locale),
          t({
            zh: `- 仔细重新观察弹窗边框，精确定位右上角关闭按钮（坐标应与 (${last.x}, ${last.y}) 差距很大）\n`,
            en: `- Carefully re-examine the popup border and precisely locate the top-right close button (coordinates should be far from (${last.x}, ${last.y}))\n`,
          }, locale),
          t({
            zh: `- 或按 Escape 键：{"action": "press-key", "key": "Escape", "reason": "..."}\n`,
            en: `- Or press Escape: {"action": "press-key", "key": "Escape", "reason": "..."}\n`,
          }, locale),
          t({
            zh: `- 或点击弹窗外部空白区域（如角落 (8, 8)）\n`,
            en: `- Or click an empty area outside the popup (e.g., corner (8, 8))\n`,
          }, locale),
          t({
            zh: `- 禁止再次返回 (${last.x}, ${last.y}) 附近的坐标！\n\n`,
            en: `- Do NOT return to coordinates near (${last.x}, ${last.y}) again!\n\n`,
          }, locale),
        )
      }
    }
  }

  parts.push(
    t({
      zh: `返回以下格式之一：\n\n`,
      en: `Return one of the following formats:\n\n`,
    }, locale),
    t({
      zh: `- 点击元素：{"action": "click", "x": <number>, "y": <number>, "reason": "..."}\n`,
      en: `- Click element: {"action": "click", "x": <number>, "y": <number>, "reason": "..."}\n`,
    }, locale),
    t({
      zh: `- 等待加载：{"action": "wait", "reason": "..."}\n`,
      en: `- Wait for loading: {"action": "wait", "reason": "..."}\n`,
    }, locale),
    t({
      zh: `- 滚动页面：{"action": "scroll", "direction": "up" | "down", "reason": "..."}\n`,
      en: `- Scroll page: {"action": "scroll", "direction": "up" | "down", "reason": "..."}\n`,
    }, locale),
    t({
      zh: `- 输入文字：{"action": "type", "text": "...", "reason": "..."}\n`,
      en: `- Type text: {"action": "type", "text": "...", "reason": "..."}\n`,
    }, locale),
    t({
      zh: `- 按下按键：{"action": "press-key", "key": "Escape" | "Enter" | ..., "reason": "..."}\n`,
      en: `- Press key: {"action": "press-key", "key": "Escape" | "Enter" | ..., "reason": "..."}\n`,
    }, locale),
    t({
      zh: `- 任务完成：{"action": "done", "success": true/false, "reason": "..."}\n\n`,
      en: `- Task complete: {"action": "done", "success": true/false, "reason": "..."}\n\n`,
    }, locale),
    t({
      zh: `只返回 JSON，不要其他文字。`,
      en: `Return only JSON, no other text.`,
    }, locale),
  )

  return parts.join('')
}

export function queryPrompt(prompt: string, locale: Locale): string {
  return `${prompt}\n\n${t({
    zh: '只返回纯 JSON，不要任何其他文字或 markdown。',
    en: 'Return only pure JSON, no other text or markdown.',
  }, locale)}`
}
