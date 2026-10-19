---
id: expedition-collect
name: Collect Expeditions
description: Open the expedition interface, collect completed expeditions, and re-dispatch characters.
enabled: false
timeoutMs: 600000
retries: 0
dependsOn:
  - welkin-moon
contexts: [ui, reward, navigation]
---

## Background

你正在原神游戏世界中操作。探索派遣通过稻妻城冒险家协会的凯瑟琳进入。

## Goal

收取所有已完成的探索派遣奖励，并重新派遣角色。

操作步骤：
1. 按 `M` 打开世界地图。
2. 等待世界地图完全显示。
3. 打开区域选择器并选择「稻妻」。
4. 在地图中显示稻妻城。
5. 选择距离冒险家协会最近的普通传送锚点。
6. 传送到该锚点。
7. 在锚点圆形平台原地转向木桥，将角色横向移动到左侧石灯笼旁的铺装桥头；从桥面中线走到花见坂上层主街，沿主街移动到凯瑟琳面前并交互。
8. 选择「探索派遣」。
9. 收取所有已完成的探索派遣。
10. 点击「再次派遣」，按上次配置重新派遣。
11. 关闭界面并回到游戏世界。

如果所有派遣都在进行中（没有已完成的），直接关闭并报告 done success。

## Steps

- keyPress: M
- aiWaitFor: 世界地图已经打开，可以看到区域、传送锚点和右下角的地图区域切换按钮
- aiAct: 点击右下角地图区域切换按钮，选择「稻妻」，并调整地图视图直到显示稻妻城
- aiWaitFor: 世界地图显示稻妻区域，并且能看到稻妻城的普通传送锚点
- click: 681,432
- aiWaitFor: 右侧显示所选普通传送锚点的详情和「传送」按钮
- aiTap: 传送
- aiWaitFor: 传送加载完成，角色已经站在稻妻城游戏主界面
- aiAct: 角色保持站在锚点圆形石板平台上，原地将镜头水平旋转 180 度朝向角色身后，直到画面左侧显示两座石灯笼之间的铺装桥头且正前方能看到木桥；完成后停止，不移动角色
- aiWaitFor: 角色仍站在锚点圆形石板平台上，画面左侧能看到两座石灯笼之间的铺装桥头，正前方能看到木桥
- keyDown: A
- wait: 1s
- keyUp: A
- aiWaitFor: 角色已经离开圆形平台并站在与木桥桥头相连的铺装石板路面上，画面中能清楚看到木桥桥面
- move: 950,350
- mouseDown: left
- wait: 500ms
- move: 550,350
- wait: 500ms
- mouseUp: left
- wait: 1s
- aiWaitFor: 角色站在铺装桥头，镜头沿木桥桥面中线朝向桥另一端
- keyDown: W
- wait: 2s
- keyUp: W
- aiWaitFor: 角色已经穿过木桥并站在桥另一端的花见坂上层石板主街中央
- aiAct: 沿花见坂上层石板主街向小地图上的冒险家协会菱形标记前进，直到看到「凯瑟琳」姓名或对话交互提示
- aiTap: 凯瑟琳头顶或附近的对话交互提示
- aiWaitFor: 与凯瑟琳的对话选项已经出现
- aiTap: 对话选项「探索派遣」
- aiWaitFor: 探索派遣界面已打开
- aiAct: 点击「全部领取」收取所有已完成派遣；如果没有该按钮或没有完成项则不领取
- aiAct: 如果出现「再次派遣」按钮，点击它并确认所有空闲栏位按上次配置重新派遣；如果需要逐个处理，则为每个空栏选择可用角色、20小时并确认派遣
- keyPress: Escape
- aiAct: 持续按 Escape 或点击关闭，直到回到游戏主界面

## Known Issues

- 云游戏输入需要短暂按住；项目输入层会为点击保持至少 100ms、按键保持至少 500ms，以便连续移动和菜单操作被云端稳定采样。
- 角色选择界面中部分角色不可用（已在队伍中或已派遣）——选择其他可用角色。
- 领取奖励后出现物品展示弹窗——点击空白处关闭。
- 派遣时长选择——默认选择 20 小时（最长时间，收益最高）。
