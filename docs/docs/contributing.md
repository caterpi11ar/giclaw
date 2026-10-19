---
sidebar_position: 8
title: 贡献指南
---

# 贡献指南

## 开发环境

推荐使用 `pnpm`。

```bash
git clone https://github.com/caterpi11ar/giclaw.git
cd giclaw

pnpm install
pnpm build

# 初始化配置（如果尚未配置）
npx tsx src/cli.ts init
```

## 开发工作流

```bash
# 直接运行 TypeScript 源码
pnpm dev

# 运行测试
pnpm test

# 监听模式
pnpm test:watch

# 运行覆盖率门禁并生成 coverage/ 报告
pnpm test:coverage

# 不改写文件的代码规范检查
pnpm lint:check

# TypeScript 类型检查
pnpm typecheck

# 检查 high / critical 依赖漏洞
pnpm audit --audit-level high

# 校验任务定义、依赖和命名流程
pnpm start skills

# 构建
pnpm build

# 检查实际发布文件清单
pnpm test:package

# 可选：真实飞书连接器 e2e（需要真实凭证）
pnpm test:feishu

# 进化 dry-run（需已配置模型与一次真实运行记录）
pnpm start evolve --skill claim-achievements --dry-run

# 从构建产物运行
pnpm start
```

`pnpm test:coverage` 会覆盖配置、技能加载、步骤解析与执行、模型流式响应、登录与浏览器会话、取消与超时、队列、Gateway、HTTP/WebSocket、CLI、持久化和 TUI。门禁要求全局行、语句、函数和分支均不低于 99.8%，且每个存在可执行指标的源文件各项不低于 98%。纯类型声明不计入覆盖率。覆盖率是防回退信号，不代表视觉模型、真实账号、浏览器 UI、静态页面或技能提示已经被完整证明。

Pull Request 和 `main` 分支推送会在 GitHub Actions 自动运行 high / critical 依赖漏洞审计、运行数据与疑似凭据扫描、代码规范、类型检查、覆盖率测试、固定 seed 乱序测试、干净应用构建、发布包 smoke、文档类型检查和文档构建。自动化测试不会读取真实账号 Cookie、调用真实模型或启动真实游戏流程；涉及游戏界面、账号状态、模型表现或网络兼容性的变化仍需单独做真实环境验收。

改动 CLI、配置、技能行为或进化系统时，同步更新对应文档：

- CLI / 配置：`docs/docs/cli.md`、`docs/docs/configuration.md`
- 技能格式 / 共享上下文：`docs/docs/skills/writing-skills.md`、`docs/docs/skills/context-skills.md`
- 自我迭代：`docs/docs/evolution.md`
- 行为与能力状态：`docs/docs/changelog.md`、`docs/docs/roadmap.md`、首页 `docs/src/pages/index.tsx`
- 合并前至少运行 `pnpm --dir docs build`，检查断链与页面编译。

:::note
`pnpm dev` 通过 `tsx` 直接运行 TypeScript 源码，不会自动监听文件变化。`pnpm build` 产出 `dist/`，通过 `pnpm start` 或全局 `giclaw` 命令运行。
:::

## 添加新技能

最简单的贡献方式是添加新技能，无需编写 TypeScript：

1. 创建目录：`mkdir skills/my-skill`
2. 编写 `skills/my-skill/SKILL.md`（参考[编写技能](/docs/skills/writing-skills)）
3. 在 `config.json` 的 `tasks.enabled` 中添加 `"my-skill"`
4. 运行结构校验：`giclaw skills`
5. 运行编排校验：`giclaw run --dry-run --tasks my-skill`
6. 使用可见窗口完成真实流程验证：`giclaw run --no-headless --tasks my-skill`

## 更新日志要求

[更新日志](/docs/changelog)是项目发布变化的统一记录。提交包含以下任一变化时，应在“待发布”部分增加条目：

- 新功能、新任务、新命令或新配置项
- 默认行为、兼容性、模型接入方式或依赖版本变化
- 用户可以观察到的问题修复
- 能力的启用、暂停、弃用或移除
- 安全、凭据或隐私相关调整

纯格式修改、本地运行数据和不改变外部行为的内部重构无需记录。条目应描述用户结果，不要只列提交号或文件名。发布版本时，将“待发布”条目移动到新的版本标题下并补充发布日期。

GitHub PR 模板会在每次提交合并请求时提醒检查更新日志、关联文档、验证结果和敏感文件。

## 项目结构

```
giclaw/
├── src/             # TypeScript 源码
├── skills/          # 技能定义（SKILL.md 文件）
├── dist/            # 构建产物
├── docs/            # 文档站点（Docusaurus）
├── config.json      # 运行时配置
└── package.json
```
