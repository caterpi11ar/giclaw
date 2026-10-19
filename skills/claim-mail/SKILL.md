---
id: claim-mail
name: Claim Mail Rewards
description: Open the in-game mailbox and claim all pending mail rewards.
enabled: true
timeoutMs: 300000
retries: 0
dependsOn:
  - welkin-moon
contexts: [ui, reward]
---

## Background

原神云游戏中操作，游戏已加载完毕。屏幕最左侧有云游戏平台侧边栏（不可点击），派蒙菜单内容在其右侧。

## Steps

- keyPress: Escape
- aiWaitFor: 派蒙菜单已打开，可以看到菜单面板和左侧图标栏
- aiTap: 只点击派蒙菜单面板内部、圆形角色头像下方的游戏内信封图标；屏幕最左侧贴边的云游戏平台侧栏及其图标一律不要点击，不使用固定坐标
- aiAct: 检查刚才点击后的界面：如果顶部已经显示「邮箱」标题，保持不动；如果误开云游戏平台面板、名片选择界面或拍照模式，先用该界面的关闭按钮或 Escape 关闭，确认回到派蒙菜单，再重新识别并点击菜单面板内部的游戏内信封图标；如果仍停留在派蒙菜单，也重新点击正确入口。完成本步前必须看到「邮箱」标题
- aiWaitFor: 邮箱界面已打开，顶部显示「邮箱」标题和邮件数量
- aiAssert: 当前明确是游戏内邮箱界面，顶部可见「邮箱」标题；不是云游戏平台面板、名片选择界面或拍照模式，否则停止且不要领取
- aiAct: 查看底部「全部领取」按钮。如果可点击（绿色），点击它领取所有邮件附件；如果不可点击（灰色）或邮件列表为空，不做操作
- screenshot: mail-claimed
- aiAct: 如果弹出物品展示窗口，点击空白处关闭
- keyPress: Escape
- wait: 1s
- keyPress: Escape
- aiWaitFor: 回到游戏主界面

## Known Issues

- 派蒙菜单打不开：可能在对话或其他界面中，先按 Escape 退出
- 误开云游戏平台面板：关闭该面板，确认回到派蒙菜单后，只在菜单面板内部重新识别信封图标
- 误点角色头像打开名片选择界面：点 ✕ 关闭，确认回到派蒙菜单后重新识别信封图标
- 误入拍照模式（出现 F1/F2 提示）：按 Escape 退出，确认回到派蒙菜单后重新识别信封图标
- 未看到顶部「邮箱」标题：不得点击「全部领取」，先执行关闭、返回和重试入口流程
