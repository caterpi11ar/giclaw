---
id: genshin-interaction-safety
name: Genshin Interaction Safety
description: Shared Genshin context for Genshin Interaction Safety.
enabled: false
context: true
tags: [core]
---

## Background

所有技能共享的安全边界：只执行「领取」类只读操作与导航；禁止购买、充值、消耗原石/创世结晶、抽卡/祈愿、分解/丢弃物品、删除数据。

按钮文案判定：领取=「领取/全部领取/一键领取/再次派遣」；危险=「购买/兑换/前往挑战/祈愿/充值/消耗/确认支付」。外观相近时以文字为准。

## Known Issues

- 确认框默认取消/关闭，而不是确认。
- 商店、祈愿、通行证购买页不是领取路径，不要进入。
- 若领取过程中触发付费界面，立即返回上一级并停止。
