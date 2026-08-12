# skill-settings-management Specification

## Purpose
在设置页面列出已加载 Skill 及其来源，并将用户通过安装入口提交的有效 Skill 内容安装到项目 Claude Skill 目录（`.claude/skills/<skill-name>/SKILL.md`），随后刷新运行时可用 Skill。

## Requirements

### Requirement: 设置页展示已加载 Skill
设置 Webview SHALL 请求并展示当前 Skill 注册表中每个已加载 Skill 的名称、描述和来源路径。页面打开及安装成功后的快照 MUST 反映当前注册表状态。

#### Scenario: 查看现有 Skill
- **WHEN** 用户切换到设置页面的 Skill 分类
- **THEN** 页面显示所有当前已加载 Skill 的名称、描述和来源路径，或显示明确的空状态

### Requirement: 项目 Claude Skill 安装目标
系统 SHALL 将由 Skill 安装入口提供的有效 Skill 内容保存到第一个工作区根目录的 `.claude/skills/<skill-name>/SKILL.md`。Skill 名称 MUST 经校验且写入路径 MUST 受工作区路径守卫保护。

#### Scenario: 安装有效 Skill
- **WHEN** 用户通过安装入口提交名称和有效 Skill 内容，且存在工作区
- **THEN** 系统将文件写入项目 `.claude/skills/<skill-name>/SKILL.md`，重新加载该 Skill，并刷新斜杠菜单与设置页列表

#### Scenario: 未打开工作区时安装
- **WHEN** 用户尝试安装 Skill 但没有可用的工作区根目录
- **THEN** 系统不写入文件，并向设置页面返回明确的失败原因

#### Scenario: 拒绝不安全的 Skill 名称
- **WHEN** 安装请求的 Skill 名称包含路径分隔符、`..` 或不符合规范名称格式的字符
- **THEN** 系统拒绝请求且不在工作区外创建或修改文件

### Requirement: 初始后台同步后的 Skill 快照一致性
系统 SHALL 将首次后台 Skill 同步与设置页触发的来源切换、目录保存、安装后重载放入同一串行同步序列。设置页在任一同步操作成功完成后请求的 Skill 快照 MUST 只包含该次已完成同步后的注册表内容，并刷新聊天 Webview 的斜杠命令。

#### Scenario: 初始同步期间变更 Skill 来源
- **WHEN** 首次后台同步尚未完成，用户在设置页保存新的 Skill 来源或目录
- **THEN** 系统串行执行同步操作，并在保存操作返回成功时展示新配置对应的已完成注册表快照及最新斜杠命令
