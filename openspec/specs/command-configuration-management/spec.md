# command-configuration-management Specification

## Purpose
管理云效 Agent 的自定义 Command（斜杠命令）Markdown 文件：定义文件格式与安全名称、全局与项目双作用域发现与覆盖、设置页作用域化 CRUD、重载与界面一致性，以及发送时安全展开，使非技术用户也能安全扩展 Agent 的命令能力而不引入执行风险。

## Requirements
### Requirement: Command Markdown 文件格式与安全名称
系统 SHALL 将每个自定义 Command 保存为固定作用域目录中的 `<command-name>.md` 文件。命令名 MUST 以小写字母或数字开头，且其余字符仅允许小写字母、数字、`-` 和 `_`；正文 MUST 非空。文件 MAY 使用扁平 YAML frontmatter 提供可选的单行 `description`，命令名 MUST 由文件名确定。Command 正文 SHALL 仅作为模型输入文本，不得作为 shell、VS Code Command 或代码执行。

#### Scenario: 加载只有正文的有效 Command
- **WHEN** 作用域目录中存在名称合法且正文非空的 Markdown 文件
- **THEN** 系统以文件名作为命令名加载该 Command，并允许描述为空

#### Scenario: 加载带描述的有效 Command
- **WHEN** Markdown 文件包含合法的 `description` frontmatter 和非空正文
- **THEN** 系统加载命令名、描述、正文、来源路径和作用域

#### Scenario: 跳过无效 Command 文件
- **WHEN** 文件名不合法、扩展名不是 `.md`、正文为空或 frontmatter 格式无效
- **THEN** 系统不注册该文件，并通过统一 logger 记录不含正文的可定位中文日志

#### Scenario: Command 正文包含代码文本
- **WHEN** Command 正文包含 shell 命令、代码块或类似可执行内容
- **THEN** 系统仅将原文作为模型上下文，不在扩展宿主直接执行该内容

### Requirement: 全局与项目 Command 发现
系统 SHALL 从 `os.homedir()` 对应的 `~/.yunForce/command` 加载全局 Command，并从第一个工作区根目录的 `.yunForce/command` 加载项目 Command。目录不存在 SHALL 等同于空作用域且不得导致插件激活失败；没有工作区时 SHALL 仅加载全局作用域。

#### Scenario: 同时加载双作用域
- **WHEN** 全局目录与第一个工作区的项目目录均包含有效 Command
- **THEN** 系统加载两个作用域的物理快照并生成运行时有效命令集合

#### Scenario: Command 目录不存在
- **WHEN** 任一固定 Command 目录尚未创建
- **THEN** 系统将该作用域视为空列表且插件其余功能保持可用

#### Scenario: 未打开工作区
- **WHEN** 插件激活时没有工作区根目录
- **THEN** 系统加载全局 Command，并将项目作用域标记为不可用

### Requirement: 项目同名 Command 覆盖全局 Command
运行时有效命令集合 MUST 以命令名去重；全局与项目存在同名 Command 时，项目 Command SHALL 覆盖全局 Command。设置页的物理作用域列表 MUST 保留并展示被覆盖的全局文件及覆盖状态。

#### Scenario: 项目 Command 覆盖全局同名项
- **WHEN** 全局与项目目录均存在 `review.md`
- **THEN** `/review` 使用项目文件的描述和正文，且设置页仍能在全局标签查看全局文件

#### Scenario: 删除项目覆盖项恢复全局项
- **WHEN** 用户删除项目作用域的 `review.md` 且全局同名文件仍存在
- **THEN** 重载后 `/review` 自动恢复使用全局 Command

### Requirement: 设置页作用域化管理 Command
系统 SHALL 在命令设置分类提供全局/项目作用域切换、实际目录路径、列表、刷新、创建、编辑和删除操作。创建与编辑 MUST 校验名称、描述和正文；所有写入与删除 MUST 限定在当前固定作用域目录内。没有工作区时项目作用域的变更操作 MUST 禁用并说明原因。

#### Scenario: 创建全局 Command
- **WHEN** 用户在全局作用域提交合法名称、可选描述和非空正文
- **THEN** 系统在 `~/.yunForce/command/<name>.md` 写入文件并返回最新快照

#### Scenario: 创建项目 Command
- **WHEN** 用户在项目作用域提交合法 Command 且存在工作区
- **THEN** 系统在第一个工作区根目录的 `.yunForce/command/<name>.md` 写入文件并返回最新快照

#### Scenario: 编辑 Command
- **WHEN** 用户保存对现有 Command 描述或正文的有效修改
- **THEN** 系统只更新该作用域中的目标文件，并重载注册表

#### Scenario: 拒绝不安全名称
- **WHEN** 用户提交包含路径分隔符、`..`、绝对路径或非法字符的名称
- **THEN** 系统拒绝操作、不在作用域目录外创建或修改文件，并向设置页返回中文错误

#### Scenario: 删除 Command
- **WHEN** 用户确认删除某作用域中的现有 Command
- **THEN** 系统只删除对应 Markdown 文件并返回最新快照

#### Scenario: 无工作区时管理项目 Command
- **WHEN** 用户查看命令设置但当前没有工作区
- **THEN** 页面显示项目目录不可用且禁用项目创建、编辑和删除，全局管理保持可用

### Requirement: Command 重载与界面一致性
插件激活、设置页成功创建/编辑/删除以及用户手动刷新后，系统 SHALL 串行重载 Command 注册表，并向设置页返回最新双作用域快照、向聊天 Webview 推送最新斜杠候选。单个无效文件 MUST NOT 阻止其他有效 Command 加载。

#### Scenario: 设置操作后同步两个界面
- **WHEN** Command 创建、编辑或删除成功
- **THEN** 设置页列表与聊天斜杠菜单均反映同一次已完成的注册表快照

#### Scenario: 手动刷新外部修改
- **WHEN** 用户在文件系统外部修改 Command 后点击设置页刷新
- **THEN** 系统重新扫描双作用域并更新设置页与斜杠菜单

#### Scenario: 部分文件无效
- **WHEN** 扫描目录时同时存在有效与无效 Command 文件
- **THEN** 系统注册所有有效文件、跳过无效文件并保持刷新成功

### Requirement: Command 引用在发送时安全展开
Webview SHALL 单独提交所选 Command 标识与用户补充文本；Host MUST 在发送时从最新有效注册表重新解析 Command。有效 Command SHALL 以清晰边界将正文和可选补充说明组合到本轮模型输入；补充文本为空时 MUST 省略补充说明区块。Host MUST NOT 信任或执行来自 Webview 的 Command 正文。

#### Scenario: 使用 Command 并补充说明
- **WHEN** 用户选择 `/review`、输入“重点检查并发问题”并发送
- **THEN** 模型输入依次包含 `/review` 的最新正文和“重点检查并发问题”补充区块

#### Scenario: 使用 Command 不补充说明
- **WHEN** 用户选择一个 Command 后直接发送
- **THEN** 模型输入包含 Command 正文且不包含空的补充说明区块

#### Scenario: 所选 Command 发送前已失效
- **WHEN** 用户选择 Command 后该命令被删除或不再有效并随后发送
- **THEN** Host 拒绝本次发送、不给会话追加用户消息，并提示用户刷新后重新选择
