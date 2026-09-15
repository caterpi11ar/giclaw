---
sidebar_position: 4
title: CLI 参考
---

# CLI 参考

```
giclaw [options] [command]
```

## 命令

| 命令 | 说明 |
|------|------|
| `run` | 单次运行（默认） |
| `skills` | 校验并列出技能、依赖、命名流程和原子操作 |
| `daemon [options]` | Daemon 模式 |
| `init [options]` | 交互式初始化配置 |
| `config` | 显示配置路径 |
| `plugins` | 列出已发现的插件、加载状态、频道 / 服务 / 路由 / 工具与启用方式 |
| `channels` | 列出插件注册的通知频道与其配置路由 |
| `pairing [action] [channel] [value]` | 审阅并处理入站配对请求（默认为 `list`） |
| `outbox [action]` | 查看或丢弃投递失败的通知队列（默认为 `list`） |

## 全局选项

| 选项 | 说明 |
|------|------|
| `-c, --config <path>` | 配置文件路径（默认 `./config.json`） |
| `-t, --tasks <ids...>` | 指定运行的任务 |
| `-r, --routine <name>` | 运行命名一条龙流程（不能与 `--tasks` 同用） |
| `--headless / --no-headless` | 启用/禁用无头模式 |
| `--dry-run` | 仅验证配置 |
| `-v, --verbose` | 调试日志 |

## Pairing 参数

`<channel>` 是实现配对的频道，目前只有 `feishu`（默认为 `feishu`）；`--account <id>` 指定频道账号，默认用插件配置里的默认账号。

| 用法 | 说明 |
|------|------|
| `giclaw pairing list` | 列出每个账号的待处理配对码与已放行发送者 |
| `giclaw pairing approve <channel> <code>` | 批准一个配对码（大小写不敏感，前后空格会被忽略） |
| `giclaw pairing dismiss <channel> <code>` | 丢弃一个待处理请求，不批准发送者 |
| `giclaw pairing revoke <channel> <sender id>` | 撤销已放行的发送者 |
| `--account <id>` | 指定频道账号（默认 `defaultAccount`） |
| `--notify` | 批准后在同一频道告诉请求方已通过 |

未知或已过期的配对码、未配对的发送者都会以退出码 `1` 结束。`--notify` 发送失败只打印告警，不会把已完成的批准改判为失败。配对状态保存在 `~/.giclaw/data/feishu-pairing.json`（`0600`）。

## Outbox 参数

通知投递失败时不会丢失：失败的路由会连同消息写入出站队列，Daemon 下次启动时自动重投，重投仍失败的继续排队。这个命令用来查看或放弃这些待投递项。

| 用法 | 说明 |
|------|------|
| `giclaw outbox` | 列出队列中的每条待投递（频道、目标、已重试次数、入队时间、runId） |
| `giclaw outbox clear` | 丢弃整个队列，不再重投 |

队列保存在 `~/.giclaw/data/notification-outbox.json`（`0600`），最多保留 200 条 / 每条最多重试 5 次 / 超过 7 天自动过期。丢弃（`clear`）是运维明确放弃的动作，没有单独的 `flush`——重投只发生在 Daemon 启动时。

## Daemon 选项

| 选项 | 说明 |
|------|------|
| `-p, --port <number>` | Web 面板端口（默认 3000） |
| `--no-web` | 禁用 Web 面板 |

## Init 选项

| 选项 | 说明 |
|------|------|
| `--non-interactive` | 跳过交互引导，仅创建默认配置文件 |

## 示例

```bash
# 交互式初始化配置
giclaw init

# 非交互模式（CI 环境）
giclaw init --non-interactive

# 单次运行所有已启用任务
giclaw run

# 首次运行，手动登录
giclaw run --no-headless

# 仅运行指定任务
giclaw run --tasks welkin-moon claim-mail

# 运行日常一条龙（依赖会自动去重并按顺序展开）
giclaw run --routine daily

# 运行已通过真实账号验收的完整奖励流程
giclaw run --routine rewards

# 查看插件加载状态（含外部插件）
giclaw plugins

# 查看可用的通知频道与当前路由
giclaw channels

# 查看待处理的入站配对请求（飞书私聊配对）
giclaw pairing list

# 批准一个配对码，并通知请求方
giclaw pairing approve feishu RKRAM9NV --notify

# 查看 / 丢弃投递失败的通知队列
giclaw outbox
giclaw outbox clear

# 查看并校验技能目录
giclaw skills

# 验证配置
giclaw run --dry-run

# 启动 daemon 模式
giclaw daemon

# 指定端口
giclaw daemon --port 8080

# 禁用 Web 面板
giclaw daemon --no-web
```

`rewards` 与 `full` 默认都只选择 5 个已验收奖励任务；暂停的 `expedition-collect` 不在任何默认命名流程中。
