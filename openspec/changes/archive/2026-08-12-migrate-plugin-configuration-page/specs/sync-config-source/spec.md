## MODIFIED Requirements

### Requirement: 配置来源单选
系统 SHALL 在插件配置页面中提供配置来源的枚举单选，取值 `none` / `claude` / `trae`，默认 `claude`。`none` 表示不加载任何生态配置；`claude` 表示加载 Claude 生态；`trae` 表示加载 Trae 生态。三值互斥，同一时刻只生效一个来源。配置值非法时 SHALL 回退默认值 `claude`。系统 SHALL NOT 通过 `yunxiaoAgent.sync.source` VS Code 配置项读写该值。

#### Scenario: 默认加载 Claude 内容
- **WHEN** 用户尚未保存配置来源
- **THEN** 配置值为 `claude`，系统加载可用 Claude Skill 目录并注入 Claude 项目规则

#### Scenario: 非法值回退
- **WHEN** 私有存储中的配置来源为枚举外的值
- **THEN** 系统按 `claude` 处理并记录日志
