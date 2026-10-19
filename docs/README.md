# giclaw 文档站

文档站基于 [Docusaurus](https://docusaurus.io/) 构建，产品文档位于 `docs/docs/`，首页位于 `src/pages/index.tsx`。

## 安装依赖

```bash
pnpm install
```

## 本地开发

```bash
pnpm start
```

默认启动本地开发服务器并监听文档变更。

## 构建与检查

```bash
pnpm build
pnpm typecheck
```

构建产物输出到 `build/`。合并文档修改前至少运行一次 `pnpm build`，以检查断链、MDX 和页面编译错误。

## 内容维护

- 功能、行为、配置、依赖、兼容性或能力状态变化，应先更新 `docs/docs/changelog.md` 的“待发布”部分。
- 同步检查根目录 README、首页 `src/pages/index.tsx`、快速开始、配置、CLI、技能概览、上下文技能、进化、路线和 FAQ 是否受影响。
- 新增文档页时同时更新 `sidebars.ts`，并确认页面 id 能解析。
- 不在文档中写入真实 API Key、Cookie、账号信息或本地运行记录。

## 部署

```bash
pnpm deploy
```

站点配置位于 `docusaurus.config.ts`，生产地址为 `https://giclaw.cn`。
