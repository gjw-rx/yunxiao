## Context

当前设置标签仅提供静态说明；`ModelConfig` 从 `yunxiaoAgent.model.*` 读取，显式 Skill 默认目录为 `.vscode/skills`，生态 Skill 默认来源为 `none`。扩展已具备设置标签、Webview 消息通道、Skill 加载器和运行时注册表，但没有可保存的插件设置或 Skill 管理协议。

## Goals / Non-Goals

**Goals:**

- 在设置标签中读取和保存完整模型配置，且 API Key 不暴露给 Webview 或 VS Code Settings。
- 将项目 Skill 的默认位置统一为 `.claude/skills`，并显示运行时已加载 Skill 的名称、描述和来源。
- 为后续/现有安装流程提供单一、受路径保护的项目安装目标，并在安装后立即刷新可用 Skill。

**Non-Goals:**

- 不提供远程 Skill 市场、账号登录、Skill 版本管理或批量迁移 `.vscode/skills`。
- 不迁移或删除用户已有 VS Code 模型设置；它们在本次之后不再被读取。
- 不改变 Trae 来源被显式选择时的加载与规则注入行为。

## Decisions

### 由扩展私有状态保存模型配置

非敏感字段保存在 `ExtensionContext.globalState`，API Key 保存在 `ExtensionContext.secrets`。设置页通过宿主请求获得可编辑字段及 `apiKeyConfigured` 布尔值，而不是密钥本身；保存时仅在页面提交非空 API Key 时更新密钥。激活时由存储服务返回 `ModelConfig` 给 provider 和 AgentLoop。

这避免重用 `workspace.getConfiguration()`，也避免将密钥写入普通持久化状态。相比把所有字段存入 SecretStorage，此方案让可配置数据可诊断并保持最小秘密范围；相比继续使用 VS Code Settings，它满足“模型配置不走 VS Code”的边界。

### 设置页使用显式的请求/响应消息

Webview 打开时请求模型配置和 Skill 快照；保存模型和请求安装时发送经过类型化的 payload。扩展宿主校验数值范围、必填模型字段和 Skill 名称，并对成功/失败返回状态消息。模型配置保存后重建 provider 或以受控方式更新后续会话所用配置，避免把已运行的流中途切换。

### Claude 是项目 Skill 的默认约定

默认显式目录改为 `.claude/skills`，默认生态来源改为 `claude`。加载顺序保持用户级 Claude 目录后/项目级目录的既有机制，并以项目目录的可写安装目标补齐统一约定。已从重复目录加载的同名 Skill 继续按注册顺序去重。

### 安装只写受控的标准 Skill 文件

安装目标固定为第一个工作区根目录下的 `.claude/skills/<validated-skill-name>/SKILL.md`。使用路径守卫和规范化名称阻止路径穿越；没有工作区时拒绝安装并向页面展示原因。写入完成后重新加载/注册项目 Claude Skills，并刷新斜杠菜单和设置页快照。

本次不定义 Skill 的远程获取方式：任一已有或后续安装入口只要提供已校验的 Skill 内容，都使用此目标和刷新路径。

## Risks / Trade-offs

- [旧 VS Code 模型设置不会自动生效] → 首次打开设置页显示默认值和明确提示；发布说明告知用户重新保存配置。
- [Webview 被视作不可信] → 所有字段、路径和 Skill 内容由宿主验证；密钥永不回传。
- [多根工作区的目标不唯一] → 本期固定第一工作区根，并在页面显示目标；未来再引入项目选择。
- [即时重建 provider 可能影响进行中的会话] → 新配置仅用于保存完成后的新运行；活跃运行完成后再切换。

## Migration Plan

1. 增加私有模型配置存储、宿主消息处理和设置页表单，读取旧 `yunxiaoAgent.model.*` 的代码与配置贡献同时移除。
2. 将默认 Skill 目录与默认同步来源切到 Claude，并保留既有 Claude 读取和去重策略。
3. 接入项目 Skill 安装目标、刷新机制与错误反馈，补齐单元和 Webview 测试。
4. 若需要回滚，恢复 `modelConfig.ts` 的 VS Code 配置读取和 `package.json` 的模型配置项；私有存储和 `.claude/skills` 文件保持不删除。

## Open Questions

- 后续 Skill 的“安装”入口将提供本地文件、粘贴内容还是远程目录；本变更只固定其落盘与刷新契约。
