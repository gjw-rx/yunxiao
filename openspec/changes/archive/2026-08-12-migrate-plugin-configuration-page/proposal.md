## Why

模型和 Skill 仍分别依赖 VS Code Settings 与启动时扫描，已经打开的插件设置页只是静态占位，用户无法在一个入口中查看、保存和安装配置。项目默认 Skill 目录也与 Claude 生态约定不一致，增加了迁移和共享项目配置的成本。

## What Changes

- 将模型提供商、模型名、API 地址、温度、最大输出和 API Key 的读取、保存与编辑迁移到云效 Agent 的设置页面；不再通过 `yunxiaoAgent.model.*` VS Code 配置项读写模型配置。**BREAKING**
- 将设置页的模型和 Skill 分类从静态占位升级为可加载、可保存的配置界面，并在宿主与 Webview 间增加受控消息协议。
- 在 Skill 分类中展示当前已加载的 Skill 及其来源；从该页面安装的 Skill 写入项目 `.claude/skills/<skill-name>/SKILL.md`，然后刷新运行时注册表与斜杠菜单。
- 将项目默认 Skill 目录设为 `.claude/skills`，并以 Claude 作为默认生态配置来源；保留对既有 Claude 目录内容的读取。

## Capabilities

### New Capabilities
- `plugin-configuration-management`: 在扩展私有持久化存储中安全管理模型配置，并向设置 Webview 提供读取与更新接口。
- `skill-settings-management`: 在设置页面列出已加载 Skill，安装 Skill 到项目 Claude Skill 目录并刷新运行时可用 Skill。

### Modified Capabilities
- `settings-page`: 设置页由静态说明改为可读取和编辑的模型及 Skill 配置界面。
- `claude-config-sync`: Claude 项目 Skill 目录成为默认加载目录，并可在安装后刷新。
- `sync-config-source`: 默认生态配置来源从 `none` 改为 `claude`，以读取 Claude 项目内容。
- `frontend-local-adaptation`: 模型配置不再从 VS Code configuration API 读取，而改由插件配置存储提供。

## Impact

- 受影响代码包括 `package.json` 配置贡献、`src/config/modelConfig.ts`、`src/extension.ts`、设置 Webview、消息协议、Skill 注册/加载逻辑与相应测试。
- 需为 API Key 使用 VS Code SecretStorage；其余模型字段使用扩展私有持久化状态，防止再次写入 VS Code Settings。
- Skill 安装仅创建或更新当前工作区的 `.claude/skills/<skill-name>/SKILL.md`；无工作区时需要明确的不可安装反馈。
