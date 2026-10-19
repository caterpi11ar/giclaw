---
id: claim-event-rewards
name: Claim Event Rewards
description: Open the events overview and claim rewards that are already unlocked.
enabled: true
timeoutMs: 600000
retries: 0
dependsOn:
  - welkin-moon
contexts: [ui, reward, event]
---

## Background

游戏已经进入主界面。活动总览可以通过 F5 打开；云游戏可能拦截功能键，此时可从派蒙菜单进入。活动页面会随版本变化，因此只操作明确带有「领取」文字或红点的已解锁奖励。

## Goal

领取当前活动总览中已经解锁且可领取的奖励。不购买付费内容、不消耗原石、不进入活动挑战。

## Steps

- keyPress: F5
- aiAct: 如果 F5 没有打开活动总览，则按 Escape 打开派蒙菜单并点击「活动一览」图标
- aiWaitFor: 活动总览界面已打开，可以看到活动列表或奖励页面
- aiAct: 检查带红点的活动，只点击明确标记为「领取」「领取奖励」且当前已解锁的按钮；不要点击「前往任务」「前往挑战」「购买」或任何消耗货币的按钮
- screenshot: event-claimed
- aiAct: 如果出现奖励展示弹窗，点击空白处或确认按钮关闭；继续领取其余明确可领取奖励
- keyPress: Escape
- aiAct: 持续按 Escape 或点击关闭，直到回到游戏主界面

## Known Issues

- 活动 UI 每个版本都会变化，必须以「领取」文字和可点击状态为准。
- 部分活动红点代表有新内容而非奖励，不能因此进入任务或挑战。
- 遇到购买、兑换或消耗原石的确认框时立即取消。
