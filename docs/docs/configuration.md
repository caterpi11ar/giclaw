---
sidebar_position: 2
title: 配置
---

# 配置

推荐通过 `giclaw init` 交互式引导完成模型配置。也可以手动编辑配置文件。

两层覆盖优先级：`config.json` < CLI 参数。

## 配置文件路径

所有配置统一在 `~/.giclaw/config.json` 中管理。`giclaw init` 交互式引导会自动写入该文件。也可以在项目根目录放置 `config.json`，程序启动时优先加载。

## 完整示例

```json
{
  "locale": "zh",
  "model": {
    "name": "gpt-5.6-sol",
    "baseUrl": "http://127.0.0.1:3002/v1",
    "apiKey": "你的 NewAPI 用户令牌",
    "family": "gpt-5",
    "stream": true
  },
  "tasks": {
    "enabled": ["welkin-moon", "claim-mail", "claim-achievements", "claim-event-rewards", "battle-pass-claim"],
    "skillsDirs": ["./skills"],
    "routines": {
      "daily": ["welkin-moon", "claim-mail"],
      "rewards": ["welkin-moon", "claim-mail", "claim-achievements", "claim-event-rewards", "battle-pass-claim"],
      "full": ["welkin-moon", "claim-mail", "claim-achievements", "claim-event-rewards", "battle-pass-claim"]
    }
  },
  "schedule": { "cron": "0 6 * * *", "timezone": "Asia/Shanghai" },
  "browser": {
    "headless": true,
    "startupUrl": "https://ys.mihoyo.com/cloud/",
    "viewport": { "width": 1280, "height": 720 },
    "dialogAutoDismissMs": 10000
  },
  "login": {
    "successSelector": ".wel-card__content--start",
    "timeoutMs": 300000,
    "pollIntervalMs": 500
  },
  "startGame": {
    "startSelector": ".wel-card__content--start",
    "dismissSelectors": [".guide-close-btn"]
  },
  "web": { "port": 3000, "enabled": true },
  "memory": {
    "dataDir": "~/.giclaw/data",
    "maxHistory": 100,
    "maxArtifactFiles": 1000,
    "maxArtifactBytes": 1073741824
  },
  "queue": { "maxDepth": 10 },
  "logLevel": "info",
  "plugins": {
    "enabled": ["feishu"],
    "dirs": [],
    "entries": {
      "feishu": {
        "config": {
          "mode": "app",
          "appId": "cli_xxx",
          "appSecret": "env:FEISHU_APP_SECRET",
          "targets": { "ops": { "chatId": "oc_xxx" } }
        }
      }
    }
  },
  "channels": {
    "feishu": { "card": true }
  },
  "notifications": {
    "on": ["run:complete", "run:error"],
    "routes": [{ "channel": "feishu", "target": "ops" }]
  }
}
```

> 插件与连接器（飞书 / 邮件 / Webhook）的完整配置见 [扩展与连接器](./extensions)。

## 配置项参考

### 基础

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `locale` | AI 提示词语言（`"zh"` 中文、`"en"` English） | `"zh"` |
| `logLevel` | 日志级别：`debug`、`info`、`warn`、`error` | `"info"` |

### 模型

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `model.name` | 上游实际提供的模型名称；当前已验收环境使用 `gpt-5.6-sol` | `""` |
| `model.baseUrl` | OpenAI 兼容 API 地址；远程地址必须使用 HTTPS，仅 loopback 可使用 HTTP | `""` |
| `model.apiKey` | API 密钥 | `""` |
| `model.family` | Midscene 使用的模型家族；GPT 5.x 兼容模型使用 `"gpt-5"` | `""` |
| `model.stream` | 强制以流式 Chat Completions 请求上游，并在项目内聚合为完整响应 | `false` |

详细的模型配置示例请参考[模型配置指南](./models)。

### 任务

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `tasks.enabled` | 默认执行的技能 ID 列表 | 5 个已验收奖励任务 |
| `tasks.skillsDirs` | 技能目录搜索路径 | `["<内置技能目录>", "./skills", "~/.giclaw/skills"]` |
| `tasks.routines` | 命名一条龙流程；用 `--routine <name>` 运行 | `daily`、`rewards`、`full` |

默认命名流程的含义：

- `daily`：只运行月卡和邮件的轻量流程。
- `rewards`：月卡、邮件、成就、活动和纪行；与默认启用集合一致，是完整奖励流程。
- `full`：当前与 `rewards` 一致，只包含 5 个已验收奖励任务。暂停的探索派遣不会由默认流程调用。

### 进化（evolve）

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `evolve.enabled` | 是否允许自动触发（显式 `giclaw evolve` 不受限） | `false` |
| `evolve.maxGenerations` | 单次进化的最大代数 | `3` |
| `evolve.maxWallClockMs` | 单次进化的墙钟上限 | `1800000`（30 分钟） |
| `evolve.maxModelCalls` | 单次进化的模型调用上限 | `10` |
| `evolve.regressionFactor` | 候选成功但耗时超过基线 × 该系数即视为回归 | `1.5` |
| `evolve.requireApproval` | 通过后是否等待人工确认才接受 | `true` |
| `evolve.maxPatchLines` | 单次补丁的最大改动行数 | `40` |
| `evolve.modelTimeoutMs` | 诊断/提案单次模型调用超时 | `120000` |
| `evolve.allowedSkills` | 允许进化的技能；空表示全部 | `[]` |

### 调度

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `schedule.cron` | Cron 表达式（Daemon 模式定时触发） | `"0 6 * * *"` |
| `schedule.timezone` | 时区 | `"Asia/Shanghai"` |

### 浏览器

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `browser.headless` | 是否无头模式运行 | `true` |
| `browser.startupUrl` | 云原神启动页 URL | `"https://ys.mihoyo.com/cloud/"` |
| `browser.viewport.width` | 浏览器视口宽度（像素） | `1280` |
| `browser.viewport.height` | 浏览器视口高度（像素） | `720` |
| `browser.cookieFilePath` | Cookie 持久化文件路径 | `"~/.giclaw/cookies.json"` |
| `browser.dialogAutoDismissMs` | 浏览器弹窗自动关闭等待时间（毫秒） | `10000` |

### 登录

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `login.successSelector` | 登录成功后检测的 CSS 选择器 | `".wel-card__content--start"` |
| `login.timeoutMs` | 等待手动登录的超时时间（毫秒） | `300000`（5 分钟） |
| `login.pollIntervalMs` | 检测登录状态的轮询间隔（毫秒） | `500` |

保存的 Cookie 会先用最多 60 秒尝试恢复；恢复失败**不会删除** Cookie，而是回退到可见浏览器人工登录，成功后覆盖。

### 启动游戏

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `startGame.startSelector` | "开始游戏"按钮的 CSS 选择器 | `".wel-card__content--start"` |
| `startGame.dismissSelectors` | 启动后需要关闭的引导弹窗选择器列表 | `[".guide-close-btn"]` |

### Web 面板

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `web.enabled` | 是否启用 Web 面板（Daemon 模式） | `true` |
| `web.port` | Web 面板监听端口 | `3000` |

### 内存 / 持久化

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `memory.dataDir` | 数据存储目录（transcript、截图等） | `"~/.giclaw/data"` |
| `memory.maxHistory` | 保留的运行历史记录条数 | `100` |
| `memory.maxArtifactFiles` | transcript 与截图合计最多保留文件数 | `1000` |
| `memory.maxArtifactBytes` | transcript 与截图合计最大字节数，超出时从最旧文件开始清理 | `1073741824`（1 GiB） |

### 队列

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `queue.maxDepth` | 任务队列最大深度（防止堆积） | `10` |

### 插件 / 通知

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `plugins.enabled` | 启用的插件 id 列表（`webhook` / `feishu` / `smtp` / `imap` 内置） | `[]` |
| `plugins.dirs` | 外部插件目录（每个子目录含 `giclaw.plugin.json`） | `[]` |
| `plugins.entries.<id>.config` | 单个插件的私有配置 | `{}` |
| `channels.<id>` | 频道级配置（当前与 `plugins.entries.<id>.config` 等价，保留给多频道扩展） | — |
| `notifications.on` | 触发通知的事件，可选 `run:complete` / `run:error` | `["run:complete", "run:error"]` |
| `notifications.routes` | 通知路由：`{ channel, target? }`，逐个频道派发；失败只记日志 | `[]` |

插件密钥支持 `env:NAME` 与 `file:/abs/path` 两种间接引用；`giclaw plugins` 会列出每个插件的加载状态、频道、服务与路由，`GET /api/plugins` 提供同样的信息。
