---
sidebar_position: 5
title: Daemon 模式
---

# Daemon 模式

常驻后台，按 cron 定时执行，支持 TUI 仪表盘 + Web 面板。

## 启动

```bash
giclaw daemon

# 指定端口 / 禁用 Web
giclaw daemon --port 8080
giclaw daemon --no-web
```

## 默认行为

- **调度**：每天 06:00（Asia/Shanghai）
- **任务**：执行 `tasks.enabled`；默认运行全部 5 个已验收奖励任务
- **TUI**：TTY 环境自动渲染 ink 仪表盘
- **非 TTY**：回退到纯日志输出
- **Web 面板**：默认启用，仅监听 `127.0.0.1:3000`；页面会取得进程级 HttpOnly 同源会话 Cookie，API 与 WebSocket 同时校验 Host、Origin 和会话

如果定时任务只需要月卡和邮件，将 `tasks.enabled` 调整为 `daily` 中的两个任务。`rewards` 与 `full` 默认都只包含 5 个已验收奖励任务，暂停的探索派遣不会被调度。

Web 面板以“当前机器是可信的单用户工作站”为支持边界。loopback、Host、Origin 和 SameSite 校验用于阻止远程访问、DNS rebinding 与恶意网页跨站调用，不用于隔离同机的其他系统用户或已取得当前用户权限的本地进程；共享主机应使用 `--no-web`。

收到 SIGINT 或 SIGTERM 后，daemon 会先停止接收新任务并取消当前登录或执行，再关闭浏览器与 Web 服务。为避免未知页面上的副作用继续发生，等待中的任务不会在关停阶段启动。

## 通知与集成

`run:complete` / `run:error` 会被派发到 `notifications.routes` 里配置的频道（飞书 / 邮件 / Webhook），入站连接器（飞书事件、IMAP、我方签名的 Webhook）也可以反过来触发已配置的 routine。启用步骤与配置示例见[扩展与连接器](./extensions)。

```bash
giclaw plugins      # 插件加载状态（[x] 已加载 / [!] 加载失败并给出原因）
giclaw channels     # 已注册的通知频道与当前路由
```

连接器默认全部关闭，未启用时不发起任何出站请求、不开放任何入站路由。通知派发是非阻塞的：单条通知失败只写日志，不会影响这次运行的结果。

## 自定义调度

通过 `config.json` 修改 cron 表达式和时区：

```json
{
  "schedule": {
    "cron": "0 6 * * *",
    "timezone": "Asia/Shanghai"
  }
}
```
