# 扩展与连接器（Extension / Connector）

> 状态：已实现。第一、二节是对 openclaw 真实插件系统的调研记录，第三节起是 Giclaw 实际落地的结构；「五、内置连接器速查」是配置参考。

本文回答两件事：

1. **openclaw 到底是什么、它的插件系统长什么样**（基于真实仓库 `github.com/openclaw/openclaw` 的源码与文档）。
2. **Giclaw 如何严格照它的架构落地**，以接入飞书、邮件、Webhook 等外部系统，同时不破坏 Giclaw 现有的安全模型（私有文件 `0700/0600`、HTTPS 校验、密钥脱敏、`提交不可取消`）。

---

## 一、openclaw 是什么

openclaw 是开源的**个人 / 团队 AI 助理**：它跑在你自己的设备上，在**你的频道**里（Discord、飞书、Slack、Telegram、WhatsApp、iMessage、IRC、Matrix、Teams、Line、Zalo、Synology Chat、nextcloud-talk、IMAP 邮件……）用**你的规则**帮你真正干活。官方 VISION 的定位是 “the AI that actually does things — runs on your devices, in your channels, with your rules.”。

几个关键事实（决定了它的架构）：

- **不是单一 App，而是一个 Gateway + 一堆插件的运行时。** 一个共享 Gateway 就是一个协作空间，一个 session 可以承载多个真人。
- **它用自己开发自己**（团队在 team.openclaw.ai 上用它做日常）。
- **优先级明确**：安全 / 安全默认值 > Bug 修复与稳定性 > 安装可靠性 > 模型提供商 > 消息频道 > 性能与测试基建 > 电脑操作 / Agent 框架 > CLI/Web 易用性 > 桌面与移动端。
- **贡献规则**：一个 PR 对一个 issue；超过 ~5000 行的 PR 基本不会被 review——这条"约束"塑造了它**极细粒度模块化**的风格。

### 仓库形态（monorepo）

```text
openclaw/
├─ src/                 # 核心运行时（TypeScript）
│  ├─ gateway/          # Gateway 进程、生命周期、协议
│  ├─ channels/         # 频道抽象层（account、allowlist、conversation...）
│  ├─ plugins/          # 插件系统核心：manifest、registry、loader、api、capability
│  ├─ plugin-sdk/       # 对外插件 SDK 门面（plugin 作者 import 的唯一入口）
│  ├─ config/           # OpenClawConfig 类型、schema、归一化
│  ├─ entry*.ts         # 进程入口 / respawn / compile-cache
│  ├─ acp/ agents/ tasks/ cron/ memory/ mcp/ ...  # 能力子系统
│  └─ web/ tui/ cli/    # 各交互面
├─ extensions/          # 内置插件（每个都是独立 npm 包）
│  ├─ feishu/ imap/ webhooks/ discord/ slack/ line/ sms/ ...（150+ 个）
│  └─ tsconfig*.json
├─ packages/            # 共享包（plugin-sdk、gateway-protocol、net-policy...）
├─ apps/                # 各平台伴侣 App（macos/ios/android/linux/mobile）
├─ docs/                # 文档（含 docs/plugins/reference/<id>.md，154 个参考页）
└─ ui/ deploy/ scripts/ ...
```

### 插件系统的一句话总结

> **核心只保留最小内核；所有能力以插件形式发布；反复出现的能力需求才被提升为契约（contract）。**

插件分两类：

- **代码插件（code plugin）**：导出 `register(api)`，在运行时注册能力。
- **Bundle 风格插件**：以 manifest + 声明式能力为主。

---

## 二、openclaw 插件系统的严格拆解

### 2.1 一个插件包的目录结构（以 `extensions/feishu` 为例）

```text
extensions/feishu/
├─ package.json            # npm 包；含 openclaw 专用字段
├─ openclaw.plugin.json    # 插件清单（manifest）——加载/校验先读它，不执行代码
├─ index.ts                # 默认导出 = defineBundledChannelEntry(...)
├─ setup-entry.ts          # 轻量 setup 入口（安装/向导流程，不拉全量 runtime）
├─ channel-plugin-api.ts   # 门面：export { feishuPlugin } from "./src/channel.js"
├─ secret-contract-api.ts  # 密钥契约（哪些配置是 secret）
├─ runtime-api.ts          # 设置 runtime 单例
├─ api.ts                  # registerXxxTools 的聚合导出
├─ skills/                 # 该插件附带的 skills（SKILL.md）
└─ src/                    # 真正的实现（几十个细粒度模块 + 每个都有 .test.ts）
```

### 2.2 `package.json` 里的 `openclaw` 字段

```jsonc
{
  "name": "@openclaw/feishu",
  "type": "module",
  "dependencies": { "@larksuiteoapi/node-sdk": "...", "zod": "..." },
  "devDependencies": { "@openclaw/plugin-sdk": "workspace:*" },
  "peerDependencies": { "openclaw": ">=2026.9.4" },
  "openclaw": {
    "extensions": ["./index.ts"],          // 代码入口
    "setupEntry": "./setup-entry.ts",      // setup 入口
    "channel": {                            // 频道元数据（用于 UI 列表 / 安装向导）
      "id": "feishu",
      "label": "Feishu",
      "selectionLabel": "Feishu/Lark (飞书)",
      "docsPath": "/channels/feishu",
      "blurb": "飞书/Lark enterprise messaging with doc/wiki/drive tools.",
      "aliases": ["lark"],
      "order": 35,
      "quickstartAllowFrom": true,
      "configuredState": { "specifier": "./configured-state", "exportName": "hasConfiguredFeishuChannelState" },
      "setup": { "fields": [] }
    },
    "install": { "npmSpec": "@openclaw/feishu", "defaultChoice": "npm", "minHostVersion": ">=2026.5.29" },
    "compat": { "pluginApi": ">=2026.9.4" },
    "build": { "bundledDist": false, "openclawVersion": "2026.9.4" },
    "release": { "publishToClawHub": true, "publishToNpm": true }
  }
}
```

### 2.3 `openclaw.plugin.json`（清单 / manifest）

加载流程**只读清单**就能完成发现、校验、UI 呈现，**绝不因为读清单而执行插件代码**。

```jsonc
{
  "id": "imap",
  "categories": ["inbox-collaboration"],
  "name": "IMAP email trigger",
  "description": "Watch IMAP mailboxes and dispatch authenticated incoming email to isolated agent sessions.",
  "activation": { "onStartup": true },
  "enabledByDefault": false,
  "channels": ["feishu"],                  // 声明提供哪些 channel
  "contracts": { "tools": ["feishu_doc", "feishu_bitable_..."] },
  "toolMetadata": { "feishu_doc": { "configSignals": [ { "rootPath": "channels.feishu", "required": ["appId","appSecret"] } ] } },
  "skills": ["./skills"],
  "configSchema": { "type": "object", "additionalProperties": false, "properties": { /* JSON Schema */ } },
  "configContracts": {
    "secretInputs": { "bundledDefaultEnabled": false, "paths": [ { "path": "accounts.*.password", "expected": "string", "ownerKind": "route" } ] },
    "dangerousFlags": [ { "path": "accounts.*.senderAuth.min", "equals": "unverified" } ]
  },
  "uiHints": { "accounts.*.password": { "label": "IMAP password", "sensitive": true } }
}
```

关键设计：**配置的存在性、敏感性、危险性都在清单里声明**，核心据此做脱敏、告警、默认关闭，而不需要理解插件内部逻辑。

### 2.4 入口定义（SDK 门面）

插件作者只从 `openclaw/plugin-sdk/*` 导入。核心入口构造器：

| 构造器 | 用途 |
| --- | --- |
| `definePluginEntry({ id, name, description, configSchema, register })` | 通用代码插件（如 `imap`、`webhooks`） |
| `defineChannelPluginEntry(...)` | 频道插件（在 `register` 里注册 channel） |
| `defineBundledChannelEntry({ id, plugin, secrets, runtime, registerFull })` | 内置频道插件：把 plugin / secrets / runtime 拆成独立子入口，按需懒加载 |
| `defineSetupPluginEntry(...)` / `defineBundledChannelSetupEntry(...)` | 安装/向导阶段入口，避免拉起完整 runtime |

`register(api)` 的 `api` 是**能力注册表**，典型方法（节选自真实 `OpenClawPluginApi`）：

```ts
api.registrationMode                 // "full" | "metadata" | ...
api.pluginConfig                     // 该插件自己的配置对象
api.logger                           // 结构化日志
api.runtime                          // 受信任的原生插件运行时助手（tasks/agents/hooks/channels...）
api.config                           // 全局配置

api.registerChannel(channelPlugin)   // 注册一个频道
api.registerTool(...)                // 注册工具（供 agent 调用）
api.registerService({ id, start, stop })  // 注册长驻服务（如 IMAP 监听、轮询）
api.registerHttpRoute({ path, auth, match, handler })  // 注册 HTTP 路由（webhook 接入点）
api.registerHook(...)                // 生命周期钩子
api.registerCommand(...)             // CLI/命令
api.registerProvider(...)            // 模型/媒体/搜索等 provider
api.registerReload(...)              // 配置热重载
api.registerCliBackend(...)
```

**注册模式（`registrationMode`）** 是关键：metadata 阶段只登记能力、不启动服务；full 阶段才真正启动。`imap` 插件就写了 `if (api.registrationMode !== "full") return;`，再注册 `imap-watch` service。

### 2.5 四层加载

1. **Manifest + Discovery**：扫描插件目录 / npm 包，读 `openclaw.plugin.json` + `package.json#openclaw`。
2. **Enablement + Validation**：按配置决定启用哪些；用 manifest 里的 `configSchema` / `configContracts` 校验配置（含 secret 解析、危险开关检测）。**不执行插件代码**。
3. **Runtime Loading**：只对启用的插件 `import()` 其入口，调用 `register(api)`，此时 `registrationMode === "full"`。
4. **Surface Consumption**：Gateway / CLI / Web / TUI 消费已注册的能力（channels、tools、services、http routes、命令……）。

### 2.6 频道插件（channel plugin）

频道 = 一种**传输 + 会话绑定**。它同时包含：

- **inbound**：从外部系统收消息 → 去重 → 发送者认证 / allowlist → 解析会话 → 投递给 agent。
- **outbound**：把 agent 回复路由回外部系统（`message` adapter：发送、编辑、媒体、分页、流式预览、限流恢复……）。

openclaw 的 message adapter 面很大（`docs/plugins/sdk-channel-plugins/message-adapter.md`）：stability、副作用、分页、draft streaming、rate limit、cancel-mid-stream 等都有明确契约，并且用 `__traces__/*.trace.jsonl` 做回归。

### 2.7 具体参考插件（与 Giclaw 目标最相关）

- **`extensions/webhooks`**：`definePluginEntry` + `api.registerHttpRoute({ path, auth: "plugin", match: "exact", handler })`，配置里 `routes.*.secret` 走 `configContracts.secretInputs` 声明为 secret。这是"**带签名校验的通用入站 Webhook**"的官方范式。
- **`extensions/imap`**：`definePluginEntry` + `api.registerService({ id: "imap-watch", start, stop })`，用 `enabledByDefault: false` 默认关闭，配置里 `accounts.*.password` 是 secret，且有 `senderAuth.min`、`allowedSenders`、`addressTokens` 等入站安全控制。**openclaw 的邮件只有入站触发（IMAP），没有 SMTP 出站频道。**
- **`extensions/feishu`**：最复杂的频道插件之一，`defineBundledChannelEntry` 拆分 plugin/secrets/runtime，`registerFull` 里注册 docs/bitable/wiki/drive 工具，配置同时出现在 `channels.feishu`（频道）与工具 `configSignals`。

---

## 三、Giclaw 严格映射

Giclaw 是一个单包 CLI/daemon（`src/gateway` + `src/web` + `src/skills`），没有"人类会话/agent 对话"这一层。所以**严格照搬结构，但把 channel 的语义适配为 Giclaw 的实际需求**：

| openclaw 概念 | Giclaw 对应 | 说明 |
| --- | --- | --- |
| `src/plugins/` | `src/plugins/` | 插件系统核心：manifest → registry → loader → api |
| `src/plugin-sdk/` | `src/plugin-sdk/` | 插件作者 import 的 SDK 门面 |
| `extensions/<id>/` | `extensions/<id>/` | 内置插件包（同一仓库内） |
| `openclaw.plugin.json` | `giclaw.plugin.json` | 清单，字段对齐 |
| `package.json#openclaw` | `package.json#giclaw` | 入口 / 频道元数据 / 兼容性 |
| `definePluginEntry` | `definePluginEntry` | 通用插件入口 |
| `defineChannelPluginEntry` / `defineBundledChannelEntry` | 同名 | 频道插件入口（含 setup 入口） |
| `registerChannel` | `registerChannel` | 注册"通知/控制通道" |
| `registerService` | `registerService` | 长驻服务（如 IMAP 监听、飞书长连接） |
| `registerHttpRoute` | `registerHttpRoute` | 入站 webhook 路由 |
| `registerTool` | `registerTool` | 注册 agent/内部工具（如"发送通知"） |
| `api.registrationMode` | 同名 | `"full"` / `"metadata"` |
| `api.pluginConfig` | 同名 | 插件自身配置 |
| `channels.<id>` 配置 | `channels.<id>` 配置 | 频道连接配置（对齐 openclaw） |
| `plugins.enabled` / `plugins.entries.<id>.config` | 同名 | 插件启用 / 插件私有配置 |
| `configContracts.secretInputs` | 同名 | 密钥路径声明 → 自动 `***` 脱敏 |
| `uiHints.*.sensitive` | 同名 | Web/TUI 呈现提示 |
| `__traces__/*.trace.jsonl` | 同名 | 频道行为回归轨迹 |

### 3.1 频道能力在 Giclaw 的语义

Giclaw 的 channel 不做"人机对话"，而是两条方向（**严格保留 openclaw 的 inbound/outbound 划分**）：

- **outbound（通知）**：Gateway 的 `run:complete` / `run:error` 事件 → 核心 `NotificationService` → 各 channel 的 `message` adapter → 飞书 / 邮件 / Webhook。
- **inbound（控制）**：外部系统 → 签名校验的 HTTP 路由或长驻 service → 核心 `InboundPipeline` → **固定动词**（`/status`、`/history`、`/run daily|rewards|full`）→ `gateway.enqueueRun(...)`。

> **不变量**：通知派发是非阻塞的、失败只记日志并落入出站队列等下次启动重投，**绝不把一次成功的领取改写成失败**（保持"提交不可取消"）。inbound 只暴露固定动词，不做自由文本到任务名的映射。

### 3.2 实际目录（已实现）

```text
src/plugins/                 # 内核（openclaw 四层加载）
├─ types.ts                  # PluginManifest / PluginDefinition / PluginApi / ChannelPlugin / PluginService
├─ manifest.ts               # 解析 + 校验 giclaw.plugin.json（纯数据，不执行代码）
├─ discovery.ts              # 第 1 层：内置清单 + 外部插件目录
├─ config-contracts.ts       # secretInputs / dangerousFlags / uiHints → `***` 脱敏
├─ capabilities.ts           # 已注册 channel / service / route / tool 的注册表
├─ api.ts                    # 第 3 层：构造交给插件作者的 api 对象
├─ services.ts               # 长驻服务生命周期（起停隔离，单服务失败不影响守护进程）
├─ notify.ts                 # 通知派发：run:complete / run:error → channel outbound
├─ host.ts                   # 第 2+3 层：enablement → validate → register
├─ bootstrap.ts              # 串联 discovery → host，绑定 Gateway runtime
└─ *.test.ts

src/plugin-sdk/              # 插件作者 import 的门面
├─ definitions.ts            # definePluginEntry / createChannelPlugin
├─ inbound.ts                # 入站公共设施：验签、allowlist、限流、去重
└─ index.ts

src/extensions/              # 内置插件（tsconfig rootDir = src，故在 src 下）
├─ webhook/                  # 通用出站 + 入站 webhook
│  ├─ giclaw.plugin.json  index.ts
│  └─ src/{config,signature,outbound,inbound}.ts
├─ feishu/                   # 飞书群机器人 + 应用事件回调
│  ├─ giclaw.plugin.json  index.ts
│  └─ src/{config,sign,card,client,crypto,outbound,inbound}.ts
├─ smtp/                     # 邮件出站（Giclaw 新增，openclaw 没有）
│  ├─ giclaw.plugin.json  index.ts
│  └─ src/{config,message,client,outbound}.ts
└─ imap/                     # 邮件入站（对齐 openclaw imap）
   ├─ giclaw.plugin.json  index.ts
   └─ src/{config,protocol,message,client,state,watcher}.ts
```

外部插件（第 1 层的外部分支）由 `plugins.dirs` 指定。每个条目可以是三种形态之一：

1. **一个插件包本身** —— 该目录下就有 `giclaw.plugin.json`；
2. **插件包的容器目录** —— 其每个子目录都是一个插件包；
3. **已安装的包名** —— 例如 `"@acme/giclaw-plugin-foo"`，从 Giclaw 自己的 `node_modules` 解析。

入口模块由包内 `package.json` 的 `giclaw.entry` 指定，其次 `main`，默认 `index.js`。无法解析的目录一律只记一条 `warn` 并跳过 —— 一个坏插件不会阻止守护进程启动。外部插件的 id 与内置插件冲突时，内置插件胜出。

启用后可以用 `giclaw plugins`、`GET /api/plugins`（Web 面板的 **Plugins** 标签页）查看加载状态、频道、服务、路由、工具，以及上次加载失败的原因（载荷里的 `failure` 字段）。

### 3.3 接口草案（对齐 openclaw 命名）

```ts
// src/plugins/types.ts
export type PluginRegistrationMode = "full" | "metadata";

export interface PluginManifest {
  id: string;
  name: string;
  description?: string;
  categories?: string[];
  activation?: { onStartup?: boolean };
  enabledByDefault?: boolean;
  channels?: string[];
  configSchema?: JsonSchema;
  configContracts?: {
    secretInputs?: { paths: Array<{ path: string; expected?: string; ownerKind?: string }> };
    dangerousFlags?: Array<{ path: string; equals: JsonValue }>;
  };
  uiHints?: Record<string, { label?: string; help?: string; sensitive?: boolean; advanced?: boolean }>;
}

export interface PluginDefinition {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  configSchema?: PluginConfigSchema;      // { parse(input): T }
  register?: (api: PluginApi) => void;
}

export interface PluginApi {
  registrationMode: PluginRegistrationMode;
  pluginConfig?: Record<string, unknown>;
  config: AppConfig;
  logger: PluginLogger;
  runtime: PluginRuntime;                  // 受信任助手
  registerChannel(channel: ChannelPlugin): void;
  registerService(service: PluginService): void;
  registerHttpRoute(route: PluginHttpRoute): void;
  registerTool(tool: PluginTool): void;
}

export interface ChannelPlugin {
  id: string;
  meta: { label: string; selectionLabel?: string; blurb?: string; docsPath?: string; aliases?: string[]; order?: number };
  outbound: {
    send(message: NotificationMessage, ctx: ChannelContext): Promise<ChannelSendResult>;
    probe?(ctx: ChannelContext): Promise<ChannelProbeResult>;   // 健康检查
  };
  inbound?: {
    verify(req: InboundRequest): Promise<InboundVerification>;
    parse(req: InboundRequest): Promise<InboundCommand | null>;
  };
}

export interface PluginService {
  id: string;
  start(ctx: PluginServiceContext): void | Promise<void>;
  stop?(): void | Promise<void>;
}
```

### 3.4 配置形态（对齐 openclaw）

Giclaw 现有配置是 `~/.giclaw/config.json`（项目根 `config.json` 也可，优先级 `config.json` < CLI）。新增两段，命名与 openclaw 一致：

```jsonc
{
  "plugins": {
    "enabled": ["webhook"],                 // 默认为 []，默认安全：不启用任何插件
    "entries": {
      "webhook": { "config": { "routes": { "daily": { "secret": "env:GICLAW_WEBHOOK_SECRET" } } } },
      "imap": { "config": { "accounts": { "work": { "host": "imap.example.com", "user": "bot@example.com", "password": "env:IMAP_PASS" } } } }
    }
  },
  "channels": {
    "feishu": {
      "appId": "cli_xxx",
      "appSecret": "env:FEISHU_APP_SECRET",
      "verificationToken": "env:FEISHU_VERIFICATION_TOKEN",
      "encryptKey": "env:FEISHU_ENCRYPT_KEY",
      "targets": { "daily": { "chatId": "oc_xxx" } }
    },
    "smtp": {
      "host": "smtp.example.com", "port": 465, "secure": true,
      "user": "bot@example.com", "password": "env:SMTP_PASS",
      "to": ["ops@example.com"]
    }
  },
  "notifications": {
    "on": ["run:complete", "run:error"],
    "routes": [ { "channel": "feishu", "target": "daily" } ]
  }
}
```

- **默认关闭**：`plugins.enabled` 默认 `[]`，不发起任何出站请求、不开放任何入站端口。
- **密钥引用**：只支持 `env:NAME` 与 `file:/绝对路径` 两种（刻意拒绝 openclaw 的 `exec:`，配置不该变成命令执行）；API 返回一律 `***`。
- **`smtp` 说明**：openclaw 没有出站邮件频道，Giclaw 若需要邮件通知，是**在 openclaw 范式内新增的一个 channel 插件**，并明确标注为 Giclaw 扩展。

### 3.5 与现有 Giclaw 的接线点

- `GatewayState` 已发出 `run:complete` / `run:error` / `run:start` / `progress` / `change`（`src/gateway/types.ts` 的 `GatewayEvents`）。
- `IGateway` 已有 `enqueueRun(trigger, taskIds?)` / `enqueueRunAccepted` / `getSnapshot` / `getRunHistory`（inbound 控制所需的全套读/写能力）。需要把 `trigger` 联合类型从 `'cron' | 'manual' | 'api'` 扩展为再加 `'extension'`（或复用 `'api'`）。
- 配置 schema 是 `src/config/schema.ts` 的单一 zod 对象 `appConfigSchema`（zod 默认剥离未知键），必须显式新增 `plugins` / `channels` / `notifications` 子 schema。
- 安全复用：私有文件 `0700/0600`、`isHttpsOrLoopbackHttp` 校验出站 URL、`sanitizeBoundedText` 清洗、密钥 `***`。

---

## 四、实施进度

四层加载、SDK 门面、通知派发、入站管线与四个内置连接器均已实现，并随代码一起提供测试（全局语句/分支/函数/行覆盖 ≥ 99.8%，单文件 ≥ 98%）。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| Phase 1 | 插件内核（`src/plugins/*`）、SDK 门面、`plugins`/`channels`/`notifications` 配置、webhook 样板、`giclaw plugins` / `giclaw channels` / `GET /api/plugins` | 已完成 |
| Phase 2 | 出站连接器：飞书（应用 / 自定义机器人）、SMTP（Giclaw 新增） | 已完成 |
| Phase 3 | 入站连接器：webhook 固定动词、飞书事件（长连接 + HTTP 回调共用同一套门控）、IMAP 邮箱轮询 | 已完成 |
| Phase 4 | 外部插件动态加载（目录 / 容器目录 / 已安装包名）、Web 面板 Plugins 标签页、文档接入 `docs/sidebars.ts` | 已完成 |
| Phase 5 | 飞书传输层对齐 openclaw：`connectionMode`（默认 `websocket` 长连接）+ `webhookPath` + 顶层 `encryptKey`/`verificationToken`，引入 `@larksuiteoapi/node-sdk` | 已完成 |

### 4.1 与 openclaw 的差异台账

下面三类差异**不许混为一谈**：把「平台没有对应物」写成「有意裁剪」、或把「我自己决定的偏离」写成「有意裁剪」，都是拿文档掩盖未经批准的决策。

#### A. 已对齐（曾经是偏离，已修正）

| # | openclaw | Giclaw | 结论 |
| --- | --- | --- | --- |
| A1 | 飞书事件传输默认 `websocket`（长连接，不需要公网） | 相同：`connectionMode` 默认 `websocket`，`webhook` 才注册 HTTP 路由 | 已对齐 |
| A2 | 依赖官方 `@larksuiteoapi/node-sdk` | 相同：引入 SDK（懒加载，webhook 模式不碰它） | 已对齐（由用户批准） |
| A3 | `webhookPath` 默认 `/feishu/events` | 相同 | 已对齐 |
| A4 | `encryptKey` / `verificationToken` 是顶层键 | 相同（曾错放在 `inbound.*` 下） | 已对齐 |
| A5 | 为对齐 openclaw 而引入运行时依赖 | 允许：用户明确裁定「如果是我要求参考，则允许增加依赖」 | 已批准（政策级） |
| A6 | DM 配对：8 位配对码（不含 `0O1I`）、1 小时过期、每账号最多 3 个待处理、满队列忽略新请求、只在**新建**请求时发提示 | 相同（`PAIRING_CODE_LENGTH = 8`、`PAIRING_REQUEST_TTL_MS` 1h、`MAX_PENDING_PAIRING_REQUESTS = 3`，满队列返回 `{ code: null, created: false }`） | 已对齐（可观测契约） |
| A7 | 审批入口：Control UI → Channels → DM access requests 的 Approve / Dismiss | `giclaw pairing list` / `approve` / `dismiss` / `revoke` | 已对齐（入口不同、语义相同） |
| A8 | 账号列表包含隐式默认账号 | 相同，且修正了一个边界：只配 `inbound`（不配 `appId`/`appSecret`）时也算一个账号 | 已对齐（一行正确性修正） |

配对状态的**存放位置**与 openclaw 不同：openclaw 放在 gateway 的 store（SQLite）里，因为它的 Control UI 需要跨进程读；Giclaw 没有 gateway store，所以放在插件私有文件 `~/.giclaw/data/feishu-pairing.json`（`0600`，进程内串行化 + 原子写）。这是**存储实现**的差异，上表 A6/A7 的**可观测契约**完全一致；队列满时忽略新请求、而不是挤掉最旧的一条，也是照 openclaw 的行为。

补充一个容易误判的点：**回调验签并不用 SDK**。openclaw 的 `monitor.transport.ts` 自己用 `node:crypto` 算 `sha256(timestamp + nonce + encryptKey + rawBody)`，Giclaw 的 `src/extensions/feishu/src/crypto.ts` 是同一算法（含 `x-lark-request-nonce`），所以这项**不是依赖偏离**，不需要改。SDK 只负责长连接的帧与（在 openclaw 里）`EventDispatcher` 的事件分发与解密。

#### B. 已按 openclaw 对标完成（曾经是待裁决项）

| # | openclaw | Giclaw | 结论 |
| --- | --- | --- | --- |
| B1 | 多账号 `accounts.<id>` + `defaultAccount` | 相同：`accounts.<id>` / `defaultAccount`，出站、入站门控、通知路由都按账号解析 | 已对齐 |
| B2 | `dmPolicy`（默认 `pairing`）、`allowFrom`、`groupPolicy` + `groupAllowFrom`、`groupSenderAllowFrom`、`requireMention`、`groups.<id>` | 相同：字段与默认值一致；`dmPolicy: "open"` 同样必须显式包含 `*` | 已对齐 |
| B3 | `webhookHost` / `webhookPort`（独立监听） | 相同：`webhookHost`（默认 `127.0.0.1`）/ `webhookPort`（默认 `3000`） | 已对齐 |
| B4 | 订阅 11 个事件（含 `application.bot.menu_v6`、`card.action.trigger`） | 相同：11 个事件全部订阅，其中 3 个（消息 / 菜单 / 卡片）会触发运行 | 已对齐 |
| B5 | 回调硬化：1 小时时间窗、常量时间验签、来源限流、请求体上限、`event_id` 去重 | 相同：`POST → content-type → 来源限流 → 体积 → 验签前在途上限 → 时间窗+验签 → JSON → 解密 → token → 握手 → 门控`（在途上限见 B9） | 已对齐 |
| B6 | 出站 outbox 持久化 + 启动重投递 | 相同语义：`src/plugins/outbox.ts` 把失败的通知落盘（`~/.giclaw/data/notification-outbox.json`，`0600`，原子写），Daemon 启动后自动重投，成功即出队，重投仍失败保留 | 已对齐（存储位置不同：openclaw 在 gateway store，Giclaw 在插件内核私有文件） |
| B7 | IMAP 用 `imapflow` 1.7.8 + `mailparser` 3.9.20 + `mailauth` 5.0.3（含 DKIM/SPF/DMARC 校验、IDLE 推送、指数退避重连、`UIDNEXT - 1` 游标、UIDVALIDITY 重置、at-least-once 投递 + 有界重试、`senderAuth.min` 认证强度阶梯、`addressTokens` 加号地址令牌） | 相同：`extensions/imap/src/{config,state,sender-gate,watcher}.ts` 按 openclaw 逐段移植，依赖版本与 openclaw `extensions/imap/package.json` 完全一致；自写的 `protocol.ts` / `message.ts` / `client.ts`（约 1200 行）已删除 | 已对齐（零依赖自写是唯一真正的依赖偏离，现已按 A5 政策修正） |
| B8 | ① 热重载 generation 管理（`extensions/imap/index.ts` 的 `const activeGeneration = ++generation` 模式：被超越的 start 直接返回，stop 自己 `generation += 1`）；② 内核按 `startup` + `stopRequested` 跟踪每个服务，stop 会等这次启动结算；③ 用 `openclaw/plugin-sdk/*` 子路径暴露 SDK 门面 | 相同：① IMAP watcher 与飞书长连接都照该模式管理——新的 start 先停掉上一代，被 stop 或新 start 抢跑的 start 不再留下后台连接/定时器；顺带修掉一个真实缺陷：`FeishuWsTransport.stop()` 现在会结算「还在等首次握手」的 `start()`，否则关停会永远挂在那次 start 上。② `src/plugins/services.ts` 的 `ServiceManager` 现在记录每个服务的 `startup` promise 并在 `stopAll` 里先 `stopRequested = true`、`abort`、等 `startup` 结算、再调 `stop`（openclaw `stopService` 的 `entry.stopRequested` / `ready = entry.startup`）；启动晚于 stop 的服务报 `stopped during startup`，不写进 `lastFailure`。③ `package.json` 新增 `exports`，按 openclaw 的名字发布已实现的子路径：`plugin-sdk`、`plugin-sdk/plugin-entry`、`plugin-sdk/channel-ingress-runtime`、`plugin-sdk/channel-plugin-common`、`plugin-sdk/config-contracts`、`plugin-sdk/types` | 已对齐（子路径**名称与解析方式**对齐；`test:package` 校验每个子路径都指向打包内真实产物，见 5.10） |

| B9 | 验签**之前**的在途请求上限：`FEISHU_PRE_AUTH_MAX_IN_FLIGHT = 64`，`createWebhookInFlightLimiter({ maxInFlightPerKey: 64, maxTrackedKeys: 1 })` 拿一个槽位包住未验证的请求体读取与验签，签完就释放 | 相同：`src/plugin-sdk/inbound.ts` 新增 `createInFlightLimiter`（按 key 计数 + LRU 淘汰，对应 openclaw `createWebhookInFlightLimiter`）；飞书回调为每个账号拿一个槽位（`accountId` 作 key）包住 `authenticateRequest`（验签、JSON、解密、token），**在派发之前**无论成败都释放；超限返回 `429 {code:1, msg:"Too many in-flight requests"}` | 已对齐（槽位只包住同步的验签段，不跨 `await gate.gate()`，与 openclaw「签完就释放、不让下游拖累下一次读取」一致） |

B7 移植时对 openclaw 做了两处**正确性修正**（不是裁剪，见下表 D）：`mailauth` 在没有 DMARC 策略时返回的 `dmarc` 结果里**没有 `alignment` 字段**，openclaw 直接取 `result.dmarc.alignment.dkim.underSized` 会抛异常；Giclaw 改成可选链，并通过注入式 DNS resolver 在离线环境复现了这条真实路径。另一个是 `mailboxOpen` 返回后先判断 `stopping`、再落盘游标，避免一个被放弃的连接去推进（或重置）后来者的游标。

`x-openclaw-delivery-accepted: durable` **继续不发**：这个头承诺的是**入站事件**已被持久接受（openclaw 有 gateway store，事件可以在 agent 侧重放）；Giclaw 的入站 ack 只表示"已经交给运行队列"，进程此刻崩溃仍会丢掉这次运行。B6 补上的是**出站**持久化，两者不是一回事。

#### B'. 仍需裁决的偏离

（无。原先唯一一条 B5b「验签前在途上限」已按 openclaw 补齐，见 B9。）

#### B''. 仍待对齐（正在做 / 待办）

（无。B5b 已于 B9 补齐，B8 已完成。）

#### C. 平台缺失（openclaw 有，Giclaw 没有对应运行时，不是裁剪）

这些能力全都挂在 openclaw 的 **agent 运行时**上，而 Giclaw 是「定时跑固定任务、不做对话」，所以是平台缺失而非功能裁剪：

- 飞书：回复分发器 / 流式回复、reasoning 预览、动态 agent、审批、媒体上传下载、`docx` / `drive` / `wiki` / `bitable` 技能、表情回复、成员目录、广播、群名与身份缓存。
- IMAP：`renderImapPrompt`（把邮件渲染成给模型看的提示词）。
- 其他：多 agent / 多 workspace 路由、模型/媒体/搜索等 provider 能力族、`apps/` 各平台伴侣客户端。
- SDK 子路径：openclaw 的 `exports` 里有 **341 个 `./plugin-sdk/*`**，绝大多数（`provider-*`、`memory-core-host-*`、`session-*`、`approval-*`、`realtime-*`、`image-generation-*`、`discord`、`telegram-account` …）绑在 Giclaw 没有的子系统上，对应源码在 Giclaw 里根本不存在。所以 B8 对齐的是**机制与名字**（已实现的 6 个，见 5.10），不是硬造 335 个空壳模块——空壳会让第三方插件在 import 成功之后才炸，比解析失败更难排查。
- openclaw `plugin-sdk/webhook-request-guards` 的其余部分：请求体**流式**读取（`readWebhookBodyOrReject` 的 `timeoutMs` / `profile`）、`installRequestBodyLimitGuard` 的「读到一半就报 `413`」、以及 `sendHttpRequestRejection` 在写入前先 drain 未消费的请求体。Giclaw 的插件路由拿到的是宿主已经读完并**已按大小限住**的 `rawBody`（`src/web/plugin-routes.ts`），所以没有可中途掐断的读取——这是一层平台差异，不是裁剪：入站保护靠 `FEISHU_WEBHOOK_MAX_BODY_BYTES` 在验签前先拒绝过大体积（`413`），以及 B9 的在途上限。
- 插件服务监管的其余部分：openclaw 的 `src/plugins/services.ts` 除了 B8 已对齐的 `startup` / `stopRequested` 语义，还带 runtime capability lease、服务健康上报（`serviceHealth`）、诊断事件派发与 `waitForDiagnosticEventsDrained`、cron host 注入、HTTP 路由注册域（`withPluginHttpRouteRegistry`）、以及 reload/one-shot 各自的绝对截止时间（`PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS`、`eventDrainMs` / `serviceStopMs`）。这些全部依赖 Giclaw 不存在的诊断/租约/健康子系统；Giclaw 的对应物是 daemon 层的 `settleShutdown`（10s 总预算）。

（注：DM 配对**不在**此列——它已按 A6/A7 对齐；A6 只是把 openclaw 存在 gateway store 里的队列换成了插件私有文件。）

#### D. 不是偏离，是用户要求新增

- `smtp`（openclaw 没有出站邮件频道）。
- IMAP 移植中修掉的两个真实缺陷（不改变任何可观测契约，只是少两个崩溃/竞态）：`mailauth` 在无 DMARC 策略时不返回 `alignment`，openclaw 的 `result.dmarc.alignment.dkim.underSized` 会抛异常；`mailboxOpen` 之后先判断 `stopping` 再落盘游标。

---

## 五、怎么用

### 5.1 三步启用

**第一步：把插件加进 `plugins.enabled`，并写入它的私有配置。** 配置文件默认在 `~/.giclaw/config.json`：

```jsonc
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

密钥不要写字面量，用 `env:NAME`（从环境变量读）或 `file:/绝对路径`（从文件读）。**只支持这两种引用，`exec:` 会被拒绝。**

**第二步：确认插件真的加载了。** 加载失败不会让守护进程退出，只会跳过该插件，所以必须显式检查：

```bash
giclaw plugins      # [x] 已加载 / [!] 已启用但加载失败 / [ ] 已发现未启用
giclaw channels     # 已注册的通知频道 + 当前通知路由
```

`[!]` 后面会打印失败原因（例如 `Secret reference env:FEISHU_WEBHOOK_SECRET is not set`）。Web 面板的 **Plugins** 标签页（`GET /api/plugins`）显示同样内容。

**第三步：让 daemon 跑起来。** 通知由运行事件驱动，只有 `giclaw daemon` 会派发：

```bash
export FEISHU_WEBHOOK_SECRET=...
giclaw daemon
```

`giclaw run` 单次运行也会触发 `run:complete` / `run:error`，但进程退出得快，出站通知可能来不及发完 —— 生产用法是 daemon。

### 5.2 通知路由（出站怎么走）

```jsonc
{
  "notifications": {
    "on": ["run:complete", "run:error"],
    "routes": [
      { "channel": "feishu", "target": "ops" },
      { "channel": "smtp", "target": "oncall" }
    ]
  }
}
```

- `on` 决定哪些事件通知：`run:complete`（成功结束）、`run:error`（失败）。
- `routes[].channel` 是插件注册的频道 id（`webhook` / `feishu` / `smtp`）。
- `routes[].target` 是该频道自己的目标名：飞书对应 `targets.<name>`，webhook 对应 `endpoints.<name>`，SMTP 对应 `targets.<name>`；省略则用该频道的默认目标。
- 多条路由会并发派发，各自独立成败；**任何一条失败只写日志，绝不会把一次成功的领取改写成失败**。

通知正文包含：等级（success / error）、标题、run 状态、触发来源（`cron` / `manual` / `api` / `extension`）、时间，以及每个任务的 `taskId` / 成败 / 耗时 / 消息。

### 5.3 入站能做什么

三条入站通道，语义一致：**外部输入永远不会被当成提示词**，只能映射到你已经配置好的 routine 或任务列表。

| 通道 | 触发方式 | 行为 |
| --- | --- | --- |
| `webhook` | 我方签名的 `POST` | 固定动词 `status` / `history` / `run`；`run` 同步返回这次运行的结果 |
| `feishu` | 飞书应用事件（机器人被 @） | 验签 → 白名单 → 限流 → 异步入队；先 ack `200 {"code":0}`，再跑 |
| `imap` | 允许的发件人来信 | 轮询邮箱 → 发信人门控 → 去重 → 异步入队 |

固定动词与配置的对应关系：

```jsonc
// POST /<你配置的 webhook path>
{ "command": "status" }                                  // 返回当前快照
{ "command": "history", "limit": 20 }                    // 返回最近运行记录（1–100）
{ "command": "run", "routine": "daily" }                 // 跑命名流程
{ "command": "run", "tasks": ["welkin-moon"] }           // 跑指定任务
{ "command": "run" }                                     // 跑 tasks.enabled 默认集合
```

飞书与 IMAP 用配置里的 `routine` / `tasks` 决定"被触发时跑什么"，消息文本只用于日志与去重：

```jsonc
{
  "inbound": { "routine": "daily" },          // 飞书：谁 @ 机器人都跑 daily
  "accounts": { "main": { "routine": "daily" } } // IMAP：允许的发件人来信就跑 daily
}
```

不写 `routine` 时退回该插件配置块的 `tasks`，再退回 `tasks.enabled`。

### 5.4 `webhook` — 通用出站 + 入站

| 方向 | 配置 | 说明 |
| --- | --- | --- |
| 出站 | `endpoints.<name>.url`（必填）、`secret`、`headers`、`defaultEndpoint` | `POST` JSON，头 `x-giclaw-signature: sha256=<HMAC-SHA256(secret, 原始正文)>` |
| 入站 | `inbound.path`（**必填，无默认值**）、`inbound.secret`（必填）、`inbound.commands`、`inbound.maxBodyBytes` | 校验同一个 HMAC 头，正文只接受固定动词 |

```jsonc
{
  "plugins": {
    "enabled": ["webhook"],
    "entries": {
      "webhook": {
        "config": {
          "endpoints": {
            "ops": { "url": "https://example.com/giclaw", "secret": "env:GICLAW_HOOK_SECRET" }
          },
          "inbound": {
            "path": "/giclaw/inbound",
            "secret": "env:GICLAW_INBOUND_SECRET",
            "commands": ["status", "run"],
            "maxBodyBytes": 65536
          }
        }
      }
    }
  },
  "notifications": { "routes": [{ "channel": "webhook", "target": "ops" }] }
}
```

入站地址就是 `http://127.0.0.1:3000/giclaw/inbound`（插件声明的路径直接挂在根上，没有额外前缀）。`auth: "plugin"` 的路由会**绕过面板会话 Cookie 与 Host 白名单**，因此安全完全依赖那口 HMAC 密钥：请用足够长的随机值，并且只在受信网络里暴露。

`run` 会一直等到这次运行结束才返回结果，所以调用方要留足超时（一次完整奖励流程是分钟级）；只想知道状态就用 `status` / `history`。

### 5.5 `feishu` — 飞书

两种出站模式，任选其一：

```jsonc
// A. 自定义群机器人（最省事：建群 → 群设置 → 群机器人 → 自定义机器人 → 复制 Webhook 地址）
{ "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx", "webhookSecret": "env:FEISHU_WEBHOOK_SECRET" }

// B. 企业自建应用（能发互动卡片，也能收事件）
{
  "mode": "app",
  "appId": "cli_xxx",
  "appSecret": "env:FEISHU_APP_SECRET",
  "card": true,
  "targets": { "ops": { "chatId": "oc_xxx", "receiveIdType": "chat_id" } },

  // 入站默认走长连接（不需要公网、不需要反向代理）
  "inbound": { "routine": "daily" }
}
```

| 方向 | 配置 | 说明 |
| --- | --- | --- |
| 出站 | `mode`（`app` / `webhook`）、`appId` + `appSecret`、或 `webhookUrl` + `webhookSecret`、`targets.<name>`、`card`、`timeoutMs` | 应用模式发互动卡片；自定义机器人用 `base64(HMAC-SHA256(key="${timestamp}\n${secret}", data=""))` 签名 |
| 入站传输 | `connectionMode`（`websocket` 默认 / `webhook`）、`webhookPath`（默认 `/feishu/events`）、`encryptKey`、`verificationToken` | 长连接靠握手鉴权，回调靠 `encryptKey` / `verificationToken` 鉴权 |
| 入站路由 | `inbound.routine` 或 `inbound.tasks`、`inbound.rateLimit`、`dmPolicy` / `allowFrom`、`groupPolicy` / `groupAllowFrom` / `groupSenderAllowFrom` / `requireMention` / `groups.<id>` | 只把「已验签的事件」映射到已配置的 routine / 任务集合，**永不**把消息正文当提示词 |

两种入站传输**共用同一套门控**（事件类型 → 去重 → 发送者/会话白名单 → `message_type` → @ → 限流），区别只在事件从哪来：

**A. 长连接（默认，推荐）** —— Giclaw 主动连飞书，本机不需要公网 IP、不需要反向代理/内网穿透：

```jsonc
{ "appId": "cli_xxx", "appSecret": "env:FEISHU_APP_SECRET", "inbound": { "routine": "daily" } }
```

1. 开放平台 → 应用 → **事件与回调** → **订阅方式** 选「使用长连接接收事件」；
2. 把「Verification Token」填进 `verificationToken`、开了加密就填 `encryptKey`（长连接本身靠握手鉴权，这两项只用于解出事件里的加密/校验字段）；
3. 订阅 `im.message.receive_v1`，把机器人拉进目标群；
4. 启动时若第一个握手失败会**大声报错**并持续重连（1s → 30s 指数退避封顶），不会静默不工作。

长连接用官方 SDK `@larksuiteoapi/node-sdk`（飞书的帧是 protobuf，手写等于重造一个协议栈）。它是**懒加载**的：`connectionMode` 为 `webhook` 时完全不碰 SDK。

**B. HTTP 回调** —— 需要把 `<公网地址><webhookPath>` 暴露成 HTTPS 给飞书回连：

```jsonc
{
  "connectionMode": "webhook",
  "webhookPath": "/feishu/events",
  "verificationToken": "env:FEISHU_VERIFICATION_TOKEN",
  "encryptKey": "env:FEISHU_ENCRYPT_KEY"
}
```

Web 面板默认只监听 `127.0.0.1:3000`，飞书服务器无法回连，所以选这个模式就必须自备一层反向代理或内网穿透，并保证只有飞书能访问（验签会拦住伪造请求）。校验签名需要 `encryptKey`、校验事件体里的 token 需要 `verificationToken`，所以 `refine` 要求两者**都要有**，缺哪个就拒绝加载 —— 一条只会回 `401` 的路由比没有路由更难排查。

`X-Lark-Signature` 是 **SHA-256**（不是 HMAC），加密事件用 AES-256-CBC（key = `sha256(encryptKey)`，iv = 密文前 16 字节）。

**需要的权限（自建应用，缺一个就会 99991672）**：

| 用途 | 权限 | 说明 |
| --- | --- | --- |
| 发送消息（出站通知） | `im:message` 或 `im:message:send_as_bot` | 必填，否则 `POST /open-apis/im/v1/messages` 直接拒绝 |
| 接收消息（入站触发） | `im:message` + 事件订阅 `im.message.receive_v1` | 还要把机器人拉进目标群 |
| 查群列表（拿 `chat_id` 用） | `im:chat:readonly` | 可选，`GET /open-apis/im/v1/chats` |

步骤：开放平台 → 应用 → **添加应用能力：机器人** → **权限管理**勾选上表 → **版本管理与发布** 创建版本并发布（需管理员审批）→ 事件与回调里按上面 A / B 选一种订阅方式。

其余门控细节：`dmPolicy`（`pairing` 默认 / `allowlist` / `open` / `disabled`）管私聊，`groupPolicy`（`allowlist` 默认 / `open` / `disabled`）管群聊，`allowFrom` / `groupAllowFrom` / `groupSenderAllowFrom` 是各自的白名单（非空即白名单），也可以用 `groups.<chat_id>` 给单独一个群覆盖 `requireMention` / `enabled` / `allowFrom`。`requireMention` 默认跟着群策略走（`open` ⇒ 不要 @，`allowlist` / `disabled` ⇒ 要 @）—— 注意 `mentions: []` 不算“被提及”；`rateLimit` 默认每个 `chat_id` 每分钟 6 条；同 `event_id` 重投只跑第一次。回调模式下：未验签 / token 不符回 `401`，方法不是 `POST` 回 `405`，`content-type` 不是 `application/json` 回 `415`，请求体超过 64KiB 回 `413`，同一来源每分钟超过 120 次回 `429`，其余“被忽略”的情况一律回 `200 {"code":0}` 让飞书停止重试，真正需要跑的批在 ack 之后异步入队。长连接模式下处理器**永不抛异常**（抛了 SDK 会回 500，飞书就会重投）。

**多账号**：`accounts.<id>` 给每个租户一份配置，`defaultAccount` 选出站默认账号；`notifications.routes[].account` 选每条通知走哪个账号。

```jsonc
{
  "defaultAccount": "ops",
  "accounts": {
    "ops": { "appId": "cli_ops", "appSecret": "env:FEISHU_OPS_SECRET", "targets": { "ops": { "chatId": "oc_ops" } } },
    "support": { "appId": "cli_sup", "appSecret": "env:FEISHU_SUP_SECRET", "targets": { "tickets": { "chatId": "oc_tickets" } } }
  },
  "notifications": { "routes": [{ "channel": "feishu", "target": "ops" }, { "channel": "feishu", "target": "tickets", "account": "support" }] }
}
```

**私聊配对（`dmPolicy: "pairing"`，默认）**：陌生人给机器人发私聊时，Giclaw 不会执行任何任务，只会生成一个 8 位配对码并回一句提示（1 小时过期，每个账号最多 3 个待处理请求，满了就忽略新请求）。管理员在终端审批：

```bash
# 首次私聊会发到飞书里，也会打在 daemon 日志里：
#   Feishu pairing required: approve code RKRAM9NV for user:ou_xxx with "giclaw pairing approve default RKRAM9NV"
giclaw pairing list                      # 看待处理配对码与已放行发送者
giclaw pairing approve default RKRAM9NV  # 批准（大小写 / 前后空格不敏感）
giclaw pairing dismiss default RKRAM9NV  # 丢弃，不批准
giclaw pairing revoke  default user:ou_x  # 撤销已放行的发送者
```

配对状态在 `~/.giclaw/data/feishu-pairing.json`（`0600`），已放行发送者上限 500（超出后丢最旧的）。不想要配对就直接把 `dmPolicy` 改掉：`allowlist`（只看 `allowFrom`）或 `open`（必须显式写 `"allowFrom": ["*"]`）。

**本地 mock 联调（不需要飞书账号）**：

```bash
pnpm test:feishu     # = tsx scripts/feishu-e2e.mjs
```

这个脚本会在本地起一个假的飞书开放平台（租户令牌 / 发消息 / 群机器人 webhook / 事件回调，并像飞书一样独立校验签名），然后用**真实连接器代码**跑 62 项断言：两种出站模式、令牌缓存与过期重试、平台报错隔离、事件验签/解密/白名单/@ 门控/去重/限流、`405` / `413` / `415` / `429`（`429` 那条打的是来源限流；验签前在途上限需要 64 个同时未结算的回调，测试里由注入式 limiter 覆盖）四个回调护栏、`connectionMode` 选路（默认长连接只注册服务、webhook 模式才注册路由、缺凭据拒绝加载），以及“插件路由豁免面板会话、但面板 API 仍然要求会话”。要变成真实接入，只需把 `webhookUrl` / `appId` / `appSecret` 换成飞书后台里那三样东西；用默认的长连接时**什么都不用暴露**。

### 5.6 `smtp` — 邮件出站（Giclaw 新增，openclaw 没有）

```jsonc
{
  "host": "smtp.example.com",
  "port": 587,
  "secure": "starttls",
  "user": "giclaw@example.com",
  "password": "env:SMTP_PASSWORD",
  "from": "giclaw@example.com",
  "to": ["me@example.com"],
  "subjectPrefix": "[Giclaw] ",
  "targets": { "oncall": { "to": ["oncall@example.com"] } }
}
```

`host` 与 `from` 必填。`secure` = `starttls`（默认）/ `implicit`（465）/ `none`，其中 `none` 只允许 loopback 主机。主题用 RFC 2047 编码，正文 base64 换行 76 列，点号转义后投递。

### 5.7 `imap` — 邮件入站

```jsonc
{
  "accounts": {
    "main": {
      "host": "imap.example.com",
      "port": 993,
      "secure": true,
      "user": "giclaw@example.com",
      "password": "env:GICLAW_IMAP_PASSWORD",
      "mailbox": "INBOX",
      "allowedSenders": ["ops@example.com", "@example.com"],
      "senderAuth": {
        "min": "verified",
        "trustedAuthservIds": ["mx.example.com"],
        "acceptTrustedAuthservId": false
      },
      "addressTokens": [{ "token": "s3cret", "senders": ["ops@example.com"] }],
      "watch": { "mode": "auto", "pollSeconds": 60 },
      "routine": "daily",
      "maxBytes": 20000
    }
  }
}
```

- **只读**：邮箱以 `EXAMINE`（`readOnly: true`）打开，取信用 `BODY.PEEK[]`，轮询永远不会把邮件标记为已读。
- **不回放历史**：第一次看到邮箱时把游标初始化为 `UIDNEXT - 1`；`UIDVALIDITY` 变化时按同样规则重置。断点续跑时先补扫一次（`resume`），进入推送模式后靠 `IDLE` 唤醒，同时还保留一个定时对齐（`watch.pollSeconds`）。
- **发信人门控（三层）**：
  1. `allowedSenders` 必填（裸地址精确匹配，或 `@domain` 匹配整个域）。
  2. `addressTokens`：给允许的发件人一个加号地址令牌（`ops+s3cret@example.com`），带上正确令牌就免做认证——适合“转发到我的监控邮箱”这类场景。比对用 `timingSafeEqual`。
  3. `senderAuth.min`：`mailauth` 真实跑 DKIM / SPF / DMARC，把结果映射成四级强度 `verified > asserted > unverified > mutable`，低于 `min` 一律拒绝。`trustedAuthservIds` + `acceptTrustedAuthservId` 可以把“可信 MDA 在 `Authentication-Results` 里写的 `dmarc=pass`”当作 `asserted`。
- **超过 48 小时的邮件不再做认证**（签名/SPF 的新鲜度窗口），直接拒绝。
- **去重与重试**：用 `Message-ID`（缺失时退化到 UID）去重，重试用独立的 attempts 记录（最多 3 次）；DNS/认证临时故障（`temperror`）保守保留、下轮重扫，明确失败（`dmarc-fail` 等）直接丢弃并计数。
- **状态落盘**：`~/.giclaw/data/imap-state.json`（`0600`），记录每个账号的 `UIDVALIDITY` / `lastSeenUid`，以及发送者跳过计数、派发声明（claim，7 天过期）与重试次数。
- **文本永不解释为指令**：一封被接受的信只决定“跑哪个 routine / 任务列表”。

其它默认值：`secure: true` 表示**连接即隐式 TLS**（IMAPS，993），`secure: false` 表示先明文连接再 `STARTTLS`（不是明文投递；而且必须是 loopback，否则配置直接报错）；`rejectUnauthorized: true`；`watch.mode: auto`（服务端支持 `IDLE` 就用推送，否则退化为轮询；也可写 `idle` / `interval`）；`watch.pollSeconds: 60`（15–3600）；`senderAuth.min: verified`；`senderAuth.trustedAuthservIds: []`；`maxBytes: 20000`（超出即截断解析）；`rateLimit` 每个发件人每小时 30 封（**在门控通过后才计数**，未授权的洪水不会消耗运行预算）。把 `secure` 关掉或把 `rejectUnauthorized` 关掉都属于“危险开关”，`giclaw plugins` 会明确提示。

认证强度阶梯（`senderAuth.min` 可选值，从弱到强）：`mutable`（只看 `allowedSenders` 名义身份）→ `unverified`（有 SPF/未对齐 DKIM 证据）→ `asserted`（可信 MDA 的汇总结论）→ `verified`（`From` 域 DMARC/DKIM 对齐通过）。默认 `verified`；调低它是明显的降级，所以不会静默生效。

### 5.8 能力与边界

**能做：**

- 每次运行结束/失败，并发推送到飞书（多账号）、邮件、Webhook（互动卡片、RFC 2047 邮件、HMAC 签名 JSON）。
- 从飞书群消息 / 菜单点击 / 卡片交互、邮件、我方签名的 HTTP 请求触发已配置的 routine / 任务集合；私聊可用配对码放行。
- 用 `giclaw plugins` / `giclaw channels` / `GET /api/plugins` / Web 面板 Plugins 标签页审计加载状态、频道、服务、路由、工具与失败原因。
- 写自己的插件：实现 `PluginDefinition`（`register(api)` + 可选 `configSchema`），放进任意目录并加进 `plugins.dirs`，或发布成 npm 包后用包名引用；导入路径见 5.10。

**不能做（当前版本）：**

- 不做对话：入站不解析自由文本、不投喂模型、不调用技能外的能力。
- 通知失败不再丢：失败的路由 + 消息写进 `~/.giclaw/data/notification-outbox.json`（最多 200 条 / 每条最多重试 5 次 / 超过 7 天过期），Daemon 启动后自动重投；重投只影响通知投递，**不会**把已成功的领取改写成失败。用 `giclaw outbox` 查看、`giclaw outbox clear` 放弃。
- 没有邮件出站的已读回执、附件解析、富文本 HTML 正文；IMAP 只取文本/HTML 正文并剥离标签。
- 不做多用户：路由、密钥、比例限制都是单用户的全局配置（账号隔离是按租户，不是按使用者）。
- 飞书入站订阅 11 个事件，但只有消息、菜单点击、卡片交互三类会触发运行；其余（已读、成员变更、表情、云文档评论、会议邀请）目前只记录并丢弃。消息只处理 `text`，图片/文件/富文本一律忽略。
- 飞书回调的防重放靠 1 小时时间窗 + `event_id` 去重表（上限 2000 条），没有把请求体哈希入库的完整的重放防护。

### 5.9 服务生命周期与热重载

`api.registerService` 拿到的 `start` / `stop` 不是「一辈子只跑一次」：

- `start` 可能被再次调用（重新加载配置、重启服务）。openclaw 的写法是每个连接器自己拿一个 `generation` 计数器：每次 `start` 先 `++generation` 存下自己的代号，再停掉上一代，然后才创建新的 watcher / 连接；`stop` 自己也 `generation += 1`。于是「被 stop 抢跑的 start」和「被新一次 start 超越的 start」都不会把后台连接遗漏下来。Giclaw 的 `extensions/imap/index.ts` 与飞书长连接服务都是这个写法。
- 这层保护在内核里也有一份（`src/plugins/services.ts`）：`ServiceManager` 记下每个服务的 `startup` promise；`stopAll` 先给服务打上 `stopRequested`、`abort`、**等这次启动结算**，然后才调 `stop`（对应 openclaw `stopService` 的 `entry.stopRequested` 与 `ready = entry.startup`）。所以插件即使忘了写 generation，也不会出现「stop 已经跑完，start 的后半段又把资源建起来」；启动结算晚于 stop 的服务在结果里报 `stopped during startup`，不会被记成故障。
- `stop` 可能在 `start` 还在中途时到达（例如 daemon 启动一半就收到关闭）。此时连接器必须能结算掉自己的 `start`，不能让关停卡在一个永不会完成的握手上。
- 每个服务都会拿到一个 `AbortSignal`（`context.signal`），`stopAll` 会先 `abort` 再调 `stop`。

### 5.10 写第三方插件：SDK 子路径

第三方插件的导入路径就是 `giclaw/plugin-sdk/...`，名字与 openclaw 的 `openclaw/plugin-sdk/...` 对齐：

| 子路径 | 目标 | openclaw 对应 |
| --- | --- | --- |
| `giclaw/plugin-sdk` | `dist/plugin-sdk/index.js` | （门面；openclaw 拆成了多个） |
| `giclaw/plugin-sdk/plugin-entry` | `dist/plugin-sdk/definitions.js` | `plugin-sdk/plugin-entry`（`definePluginEntry` 等） |
| `giclaw/plugin-sdk/channel-ingress-runtime` | `dist/plugin-sdk/inbound.js` | `plugin-sdk/channel-ingress-runtime`（`IdentifierAuthentication` 阶梯、限流、去重） |
| `giclaw/plugin-sdk/channel-plugin-common` | `dist/plugin-sdk/index.js` | `plugin-sdk/channel-plugin-common`（通用频道插件类型） |
| `giclaw/plugin-sdk/config-contracts` | `dist/plugins/config-contracts.js` | `plugin-sdk/config-contracts` |
| `giclaw/plugin-sdk/types` | `dist/plugins/types.js` | `plugin-sdk/types` |
| `giclaw/package.json` | `package.json` | 同 |

只发布这些名字，不放空壳：`pnpm test:package` 会逐个检查每个子路径都落在打包文件里，测试 `src/plugin-sdk/exports.test.ts` 会检查每个目标都有对应的源码模块，两处一起拦住「声明了一个不存在的模块」。没列出的 openclaw 子路径属于上表 C（子系统不存在）。

一份最小插件（目录形式）：

```ts
// my-plugin/index.ts
import { definePluginEntry } from 'giclaw/plugin-sdk/plugin-entry'

export default definePluginEntry({
  id: 'my-plugin',
  name: 'My Plugin',
  version: '0.1.0',
  register(api) {
    if (api.registrationMode !== 'full')
      return
    api.registerService({ id: 'my-plugin-tick', start: async () => {}, stop: async () => {} })
  },
})
```

放进 `plugins.dirs` 里的目录，或用包名引用（包内需带 `giclaw.plugin.json`）。

### 5.11 安全基线

- 出站地址必须是 HTTPS 或 loopback HTTP；URL 里不允许内嵌凭据。
- 密钥支持 `env:NAME` / `file:/绝对路径` 两种间接引用（不执行命令）。
- 声明为 `secretInputs` 的路径（如 `accounts.*.password`）由 `maskDeclaredSecrets` 统一脱敏为 `***`；`dangerousFlags`（如 `rejectUnauthorized: false`）会在 `giclaw plugins` 里显式提示。
- 入站路由默认 `auth: "plugin"`，请求必须通过各自的验签；限流与去重由 `src/plugin-sdk/inbound.ts` 统一提供，连接器无法"忘记"。
- 飞书回调除了验签，还有时间窗（1 小时）、常量时间比对、来源限流（每分钟 120）、请求体上限（64KiB）与验签前在途上限（每账号 64，超限 `429`）；私聊配对码与服务密钥一样落在 `0600` 文件里。
- 私有文件与目录分别 `0600` / `0700`。
