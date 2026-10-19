<p align="center">
  <img src="docs/static/img/logo.jpeg" width="180" alt="Giclaw Logo" />
</p>

<h1 align="center">Giclaw</h1>

<p align="center">
  <strong>Genshin Impact Claw — 专为原神服务的视觉 AI 智能体</strong>
</p>

<p align="center">
  <a href="https://giclaw.cn">文档</a> · <a href="https://giclaw.cn/docs/getting-started">快速开始</a> · <a href="https://giclaw.cn/docs/skills/built-in-skills">技能列表</a> · <a href="https://giclaw.cn/docs/changelog">更新日志</a>
</p>

---

通过视觉模型理解游戏截图，并结合可审计的确定性键鼠步骤，自动完成云原神中的月卡、邮件、纪行、成就和活动奖励领取。

## 特性

- **视觉 + 确定性操作** — 视觉 AI 处理变化界面，固定键鼠步骤处理稳定入口
- **文件驱动技能** — 写一个 Markdown 就能定义新任务，无需 TypeScript
- **多模型支持** — Gemini、OpenAI、豆包、通义千问，任意 OpenAI 兼容视觉 API
- **共享游戏上下文** — 通用 UI 规则（鼠标锁定、HUD 布局、云游戏侧边栏、奖励语义、安全红线）以 `context: true` 的上下文技能集中维护，自动注入每个可运行技能，技能只需关注自身逻辑
- **Daemon 模式** — cron 定时调度 + TUI 仪表盘 + Web 面板
- **一条龙编排** — 技能依赖自动展开，支持 `daily` / `rewards` / `full` 命名流程
- **混合原子操作** — 视觉 AI 定位 + 确定性键鼠回放，共 22 种技能原子操作
- **失败可诊断** — 严格技能校验、JSONL 逐步记录、失败现场自动截图
- **云游戏适配** — 无需本地安装原神客户端，低资源占用

## 安装

运行环境：**Node >= 20.9**

```bash
npm install -g giclaw@latest
```

## 快速开始

```bash
giclaw init                  # 交互式配置
giclaw run --no-headless     # 首次运行，手动登录
giclaw run                   # 后续运行，自动执行
```

详细指南请访问 [文档站点](https://giclaw.cn/docs/getting-started)。

## 内置技能

| 技能 | 说明 | 默认状态 | 真实账号验收 |
|------|------|----------|--------------|
| `welkin-moon` | 启动云游戏，领取月卡每日奖励 | 启用 | 已通过 |
| `claim-mail` | 打开邮箱，一键领取所有邮件附件 | 启用 | 已通过 |
| `battle-pass-claim` | 打开纪行，领取等级奖励 | 启用 | 已通过 |
| `claim-achievements` | 领取已完成成就奖励 | 启用 | 已通过 |
| `claim-event-rewards` | 领取已解锁活动奖励 | 启用 | 已通过 |
| `expedition-collect` | 收取探索派遣并重新派遣 | 关闭 | 暂停，尚未完成领取与再次派遣闭环 |

```bash
giclaw skills                 # 查看技能、依赖、一条龙流程和原子操作
giclaw run                    # 默认运行 5 个已验收任务
giclaw run --routine daily    # 仅运行月卡 + 邮件
giclaw run --routine rewards  # 显式运行完整奖励流程
```

`daily` 只运行月卡和邮件；`rewards` 与 `full` 都只包含 5 个已验收奖励任务。暂停的 `expedition-collect` 不会被任何默认流程调用。

自定义技能只需在 `~/.giclaw/skills/` 下创建 `SKILL.md`，详见 [编写技能](https://giclaw.cn/docs/skills/writing-skills)。

## 自我迭代与进化

`giclaw evolve` 让 giclaw 从真实运行证据出发，自动诊断失败技能、生成对 `SKILL.md` 的**一处**最小补丁、在真实浏览器里重跑验证，成功则保留、失败则回滚。

```bash
giclaw evolve --skill claim-achievements --dry-run   # 只诊断/提案/校验，不启动浏览器
giclaw evolve --skill claim-achievements             # 完整迭代（默认需人工确认）
giclaw evolve --status                               # best-known-good / 待确认 / 最近代数
giclaw evolve --skill claim-achievements --accept --apply
```

只修改 `SKILL.md`，不生成或执行代码；候选必须先通过严格 loader 校验与红线策略（禁止购买、消耗原石/付费货币）才会运行；默认需要人工确认才写入已提交目录。详见[文档](https://giclaw.cn/docs/evolution)。

## 通知与集成

内置四个默认关闭的连接器，把"跑完了"推出去，也能把外部信号拉进来：

| 连接器 | 方向 | 能力 |
|--------|------|------|
| `feishu` | 出站 + 入站 | 群机器人 / 自建应用（多账号）推送互动卡片；事件默认走**长连接**（不需要公网或反向代理），消息 / 菜单点击 / 卡片交互触发已配置的 routine；私聊用配对码放行 |
| `smtp` | 出站 | 邮件通知（STARTTLS / 隐式 TLS / loopback 中继） |
| `imap` | 入站 | 只读监听邮箱（`IDLE` 推送，必要时退化为轮询），用 `mailauth` 真实校验 DKIM/SPF/DMARC、按认证强度门控发件人，来信即触发 routine，不会标记已读 |
| `webhook` | 出站 + 入站 | HMAC-SHA256 签名 JSON 通知；我方签名的 `status` / `history` / `run` 控制接口 |

最小用法（飞书群机器人，10 秒配好）：

```json
{
  "plugins": {
    "enabled": ["feishu"],
    "entries": {
      "feishu": {
        "config": {
          "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx",
          "webhookSecret": "env:FEISHU_WEBHOOK_SECRET"
        }
      }
    }
  },
  "notifications": {
    "on": ["run:complete", "run:error"],
    "routes": [{ "channel": "feishu" }]
  }
}
```

```bash
export FEISHU_WEBHOOK_SECRET=...
giclaw plugins      # 确认插件已加载（[x]），失败会给出原因
giclaw channels     # 查看已注册频道与通知路由
giclaw daemon       # 通知由运行事件驱动，随 daemon 派发
```

密钥只支持 `env:NAME` 与 `file:/绝对路径` 两种引用（不执行命令），API 与面板回显一律 `***`。入站消息**永远不会被当成提示词**：只能映射到你已配置的 routine 或任务列表，避免一条泄露的消息变成任意执行。私聊配对码（每人每账号最多 3 个待处理）用 `giclaw pairing list` / `approve` / `revoke` 审批。发送失败的通知会落盘，Daemon 下次启动自动重投（`giclaw outbox` 查看 / 放弃）——重投只影响通知，不会把已成功的领取改写成失败。

完整的启用步骤、飞书事件订阅配置（长连接 / HTTP 回调两种）、多账号与私聊配对、IMAP 发信人门控与安全边界见[扩展与连接器](https://giclaw.cn/docs/extensions)。

## License

MIT
