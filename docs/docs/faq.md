---
sidebar_position: 9
title: 常见问题
---

# 常见问题

## 首次登录 / Cookie 失效

**Q: 首次运行如何登录？**

推荐使用 `giclaw run --no-headless` 启动，浏览器可见窗口会打开云原神页面。手动完成账号登录后，Cookie 自动保存到 `~/.giclaw/cookies.json`，后续运行自动复用。直接运行 `giclaw run` 也可以；没有有效 Cookie 时程序会自动切换到可见浏览器。

**Q: Cookie 失效了怎么办？**

重新使用 `--no-headless` 模式运行即可：

```bash
giclaw run --no-headless
```

程序最多用 60 秒检查 Cookie 恢复状态。即使恢复失败也不会删除 Cookie，而是自动打开可见浏览器等待你重新登录；登录成功后 Cookie 自动更新。

## Chromium 下载失败

**Q: 首次运行时 Chromium 下载失败或超时？**

giclaw 优先使用 Playwright 已安装的 Chromium；对应版本不存在时会尝试复用系统 Chrome、Edge 或 Chromium。如果本机没有可用浏览器，可以尝试：

1. 检查网络连接，必要时配置代理
2. 手动安装 Playwright 浏览器：
   ```bash
   npx playwright install chromium
   ```
3. 如果在中国大陆，可以设置 Playwright 镜像：
   ```bash
   PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright npx playwright install chromium
   ```

## API 报错

**Q: 运行时提示 API 错误（401、403、429 等）？**

- **401 Unauthorized**：API Key 无效或已过期，检查 `config.json` 中的 `model.apiKey`
- **403 Forbidden**：API Key 没有访问该模型的权限，确认模型名称正确
- **429 Too Many Requests**：请求频率超限，稍后重试或升级配额
- **5xx 服务端错误**：供应商临时故障；为避免在未知 UI 状态下重放动作，本次运行会停止，请确认现场后手动重试

**Q: 为什么返回 `model_unavailable`？**

这通常表示网关没有可用的模型映射或上游通道，而不是 HTTP 服务未启动。先带 NewAPI 用户令牌请求 `/v1/models`，确认返回的精确模型 ID，再把该 ID 写入 `model.name`。当前已验收环境使用 `gpt-5.6-sol`。

**Q: 上游只能接受流式返回怎么办？**

在当前项目的 `config.json` 中设置 `"model.stream": true`。giclaw 仍使用 Chat Completions，并在进程内聚合 SSE 分片；不需要切换到 Responses API，也不需要增加环境变量。

`giclaw run --dry-run` 只验证本地配置结构和技能，不会联网验证 API Key。401/403 等鉴权问题仍需在实际运行时确认。

## 无头模式

**Q: 默认无头模式下如何登录？**

无头浏览器本身无法接受人工登录。程序发现没有 Cookie，或最多检查 60 秒后仍未恢复时，会关闭无头会话并自动打开可见浏览器。登录完成后保存新 Cookie；如果配置仍是 `headless: true`，程序会重新切回无头会话继续运行。

使用 `--no-headless` 可以让登录后的整个任务过程保持可见，适合首次验收和 UI 变更后的回归。

**Q: 如何始终使用可见浏览器？**

在 `config.json` 中设置：

```json
{
  "browser": {
    "headless": false
  }
}
```

或每次运行时加 `--no-headless`。

## 定时任务

**Q: Daemon 模式的定时任务不执行？**

检查以下几点：

1. 确认 daemon 进程正在运行：`giclaw daemon`
2. 检查 cron 表达式和时区配置：
   ```json
   {
     "schedule": {
       "cron": "0 6 * * *",
       "timezone": "Asia/Shanghai"
     }
   }
   ```
3. 确认系统时间和配置的时区一致
4. 查看日志输出确认调度器是否正常工作

## 技能执行

**Q: 技能执行超时？**

每个任务都有独立的总超时时间（默认 10 分钟），其中单个视觉等待最多持续 3 分钟，并每 15 秒输出一次等待进度。超时可能由以下原因导致：

- 网络延迟导致截图 / API 调用过慢
- AI 模型请求持续无响应
- 游戏加载或排队时间过长
- 页面进入了当前任务没有覆盖的新状态

解决方法：
- 检查网络和 API 响应速度
- 根据每 15 秒输出的进度确认具体停留步骤
- 使用 `--no-headless` 模式观察实际页面；如果页面已经可操作但等待仍未结束，应修正该步骤的可继续状态，而不是只增加总超时
- 只有在排队或加载本身确实需要更长时间时，才调整对应任务的 `timeoutMs`

**Q: 某个技能失败但其他技能正常？**

技能按 `tasks.enabled` 顺序依次执行。如果某个技能失败，整次运行会立即停止，后续技能不会在未知 UI 状态下继续。可以确认现场后通过 `--tasks` 参数单独运行某个技能：

```bash
giclaw run --tasks claim-mail --no-headless
```

如果技能声明了 `dependsOn`，所需前置技能会自动加入。例如只指定 `claim-mail` 时，系统仍会先执行 `welkin-moon` 以确保游戏已经启动。

## 日志

**Q: 如何查看详细执行日志？**

- 运行时加 `-v` 或 `--verbose` 启用 debug 级别日志
- 或在 `config.json` 中设置 `"logLevel": "debug"`
- 每次运行的详细记录（transcript）保存在 `~/.giclaw/data/transcripts/` 目录
- 执行截图保存在 `~/.giclaw/data/screenshots/` 目录

## 会话与截图

**Q: 每次运行都要重新登录？**

不会。登录成功后会保存 Cookie 到 `~/.giclaw/cookies.json`，后续运行优先复用。恢复最多检查 60 秒；即使恢复失败也不会删除 Cookie，而是回退到可见浏览器人工登录，成功后覆盖。

**Q: 任务成功 / 失败有截图吗？**

有。内置奖励技能在领取动作后有一个 `screenshot` 检查点，成功运行会在 `~/.giclaw/data/screenshots/` 留下效果图；步骤失败（包括视觉等待超时）也会先保存失败现场，再由任务清理关闭页面。

## 自我迭代

**Q: `giclaw evolve` 会自动修改我的技能吗？**

只会修改 `SKILL.md`，且默认需要人工确认：候选通过后停在待确认状态，`--accept` 才接受，`--accept --apply` 才写入已提交目录。失败或回归会自动回滚到会话前状态。它不会生成或执行任意代码。
