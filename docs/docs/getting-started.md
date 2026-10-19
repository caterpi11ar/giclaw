---
sidebar_position: 1
title: 快速开始
---

# 快速开始

Genshin Impact Claw（`giclaw`）是专为原神服务的智能体。它通过视觉模型理解游戏截图，并结合确定性键鼠步骤，自动完成月卡、邮件、纪行、成就和活动奖励领取。

视觉 AI 负责识别变化界面，稳定入口则使用有界、可审计的键鼠操作。两类步骤可以在同一个工作流中组合。

## 环境要求

- **Node.js >= 20.9**

## 安装

```bash
npm install -g giclaw@latest
# 或
pnpm add -g giclaw@latest
```

安装后全局可用 `giclaw` 命令。运行时优先使用 Playwright 已安装的 Chromium；若对应版本不存在，会复用系统 Chrome、Edge 或 Chromium，不会静默修改全局浏览器缓存。

## 交互式配置

```bash
giclaw init
```

`giclaw init` 会引导你选择模型提供商（Gemini、OpenAI、豆包、通义千问等）并配置 API key，配置保存到 `~/.giclaw/config.json`。

如果跳过 init 直接运行，程序会自动检测未配置状态并触发引导。

:::tip
在 CI 或非交互环境中，可以使用 `giclaw init --non-interactive` 创建默认配置文件，然后手动编辑 `~/.giclaw/config.json` 填入模型配置。
:::

## 首次运行

```bash
giclaw run --no-headless
```

推荐首次使用 `--no-headless`，此时浏览器保持可见，你可以完成账号登录并观察任务执行。即使按默认 headless 模式启动，没有有效 Cookie 时程序也会自动打开可见浏览器引导登录。登录成功后，Cookie 会保存到 `~/.giclaw/cookies.json`。

登录完成后，giclaw 自动接管浏览器，依次执行已启用的任务。月卡、邮件、纪行、成就和活动奖励 5 个已验收任务默认全部启用；如果只想运行月卡和邮件，可以选择 `daily` 流程。

## 后续运行

```bash
giclaw run
```

后续运行会自动复用已保存的 Cookie。Cookie 恢复最多检查 60 秒；恢复失败时**不会删除** Cookie，而是回退到可见浏览器等待你重新登录，登录成功后覆盖并按配置继续使用可见或 headless 会话。

## 验证配置

```bash
giclaw run --dry-run
```

`--dry-run` 会严格校验配置、技能文件、任务 ID、依赖图和最终执行顺序，不会启动浏览器，也不会请求模型 API。因此它不能证明 API Key 有效或游戏内流程成功。

还可以查看当前技能目录提供的全部能力：

```bash
giclaw skills
giclaw run --routine daily
giclaw run --routine rewards
```

不指定参数的 `giclaw run`、`rewards` 与 `full` 都会运行 5 个已验收任务；`daily` 只运行月卡和邮件。暂停的探索派遣能力已从全部默认命名流程移除。

## 自我迭代（可选）

技能失败时，可以让 giclaw 基于真实运行证据自己提出最小修复，并在真实浏览器里验证：

```bash
giclaw evolve --skill claim-achievements --dry-run   # 只诊断/提案/校验
giclaw evolve --skill claim-achievements             # 完整迭代（默认需人工确认）
giclaw evolve --status                               # 查看待确认与历史
giclaw evolve --skill claim-achievements --reject    # 回滚
```

只修改 `SKILL.md`，不生成代码；候选先过严格校验与红线策略，失败会回滚。详见[自我迭代与进化](./evolution)。

## 从源码安装（开发）

<details>
<summary>展开查看</summary>

推荐使用 `pnpm`。

```bash
git clone https://github.com/caterpi11ar/giclaw.git
cd giclaw

pnpm install
pnpm build

# 单次运行
pnpm start

# 直接运行 TypeScript 源码
pnpm dev
```

`pnpm dev` 通过 `tsx` 直接运行 TypeScript 源码，不会自动监听文件变化。`pnpm build` 产出 `dist/`，通过 `pnpm start` 或全局 `giclaw` 命令运行。

</details>
