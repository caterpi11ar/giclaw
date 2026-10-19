---
id: genshin-automation-pitfalls
name: Genshin Automation Pitfalls
description: Shared Genshin context for common cloud-gaming UI-automation failure modes.
enabled: false
context: true
tags: [core]
---

## Background

编写或执行原神云游戏 UI 自动化时的通用陷阱。这些规则对所有技能生效，目的是避免超时、误点和不可恢复的现场。

## Known Issues

- 单次 `aiAct` 不要写「重复直到…」的无界循环。限定为一轮遍历加明确的结束条件，并在结尾回到稳定界面；否则容易耗尽整次任务时长（真实案例：成就领取在领取项多时因此超时）。
- 领取或点击后列表会滚动、重排或刷新，必须重新识别元素，不要沿用刷新前的坐标或位置。
- 单个技能与整次运行都有超时上限。把长流程拆成多个小步骤，便于定位失败并控制预算。
- 非阻塞覆盖层（如平台画质新手引导）点不动时，直接忽略它继续主流程；不要反复点击同一个覆盖层，也不要因此报错。
- 单步 aiWaitFor 上限约 180s；加载/排队这类长时间状态应拆成多个等待步骤，避免一次等待超时。
- 失败会立即停止整次运行，不要假设可以从中间状态无缝续跑；每次运行都从头开始。
- 云游戏输入有延迟，点击与按键需要短暂按住；但也不要因此重复发送输入。
