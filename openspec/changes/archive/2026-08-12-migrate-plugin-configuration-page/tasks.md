## 1. 插件配置存储与模型运行时

- [x] 1.1 为模型非敏感字段和 API Key 分别实现 globalState/SecretStorage 存储、默认值与宿主校验，并记录关键操作日志。
- [x] 1.2 将 Provider 与 AgentLoop 的初始化改为读取插件私有模型配置，并定义保存后的安全更新时机。
- [x] 1.3 移除 `yunxiaoAgent.model.*` 的 VS Code 配置贡献、读取逻辑和变更监听，保留本次未涉及的 VS Code 设置。
- [x] 1.4 为模型配置存储、校验、密钥不回传和激活读取路径添加单元测试。

## 2. 设置页面与宿主协议

- [x] 2.1 扩展 Webview 协议和设置面板消息路由，支持模型配置读取/保存、Skill 列表读取、安装结果和错误状态。
- [x] 2.2 将模型设置静态内容替换为受控表单、API Key 配置状态和保存反馈，确保不在页面保留或显示密钥明文。
- [x] 2.3 将 Skill 设置静态内容替换为已加载 Skill 列表、来源信息、安装交互与空/错误状态；保持使用情况页为静态占位。
- [x] 2.4 添加 SettingsPage 和宿主协议的单元测试，覆盖加载、保存成功、校验失败、Skill 空状态与安装反馈。

## 3. Claude 默认项目 Skill 与安装刷新

- [x] 3.1 将默认项目 Skill 目录、同步来源和加载优先级调整为 `.claude/skills` 与 `claude`，并移除 `yunxiaoAgent.skills.directories` 与 `yunxiaoAgent.sync.source` 的 VS Code 默认读取。
- [x] 3.2 实现受路径守卫保护的项目 Skill 写入服务，将有效内容写入 `.claude/skills/<skill-name>/SKILL.md` 并拒绝无工作区和不安全名称。
- [x] 3.3 在 Skill 写入成功后重新加载注册表、刷新斜杠菜单和设置页列表；保持 Trae 被显式选择时的行为。
- [x] 3.4 为 Claude 默认加载、优先级、安装目标、路径拒绝和运行时刷新添加测试。

## 4. 验证

- [x] 4.1 运行相关单元测试和 Webview 测试，修复本变更引入的失败。
- [x] 4.2 运行 `npm run compile`，确认 TypeScript、ESLint 和 Webview 构建通过。
