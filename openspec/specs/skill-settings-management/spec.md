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
