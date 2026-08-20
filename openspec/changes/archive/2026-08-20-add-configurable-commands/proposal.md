## Why

插件当前的 `/` 菜单只包含内置功能与 Skill，用户无法把常用提示词保存为可复用的自定义 Command，也无法在设置页统一管理个人级和项目级命令。新增本地 Command 能让团队工作流与个人工作流通过文件持久化，并继续沿用用户已熟悉的斜杠引用交互。

## What Changes

- 新增 Markdown Command 配置及加载机制：全局命令从用户主目录 `~/.yunForce/command` 加载，项目命令从工作区根目录 `.yunForce/command` 加载。
- 定义 Command 文件的名称、描述、正文与来源作用域，并采用“项目同名命令覆盖全局命令”的确定性合并规则。
- 在独立设置页新增“命令”分类，提供全局/项目作用域切换、命令列表、刷新、创建、编辑和删除能力；界面结构参考附件中的命令管理页，但遵循现有 VS Code Webview 视觉体系。
- 扩展 `/` 菜单，将自定义 Command 与 Skill 明确区分展示，同时保留“基础功能”“子智能体”等现有分组。
- 选择自定义 Command 后生成可移除的 Command 引用块，不立即发送；用户可继续输入补充说明，发送时将 Command 正文与补充说明组合为本轮模型输入。
- Command 文件变更或设置页操作完成后刷新注册表、设置页快照和聊天斜杠菜单，并对无效文件给出可定位的中文日志或错误反馈。

## Capabilities

### New Capabilities

- `command-configuration-management`: 定义全局/项目 Command 的文件格式、发现、覆盖规则、设置页 CRUD、刷新与运行时展开行为。

### Modified Capabilities

- `slash-command-menu`: 将自定义 Command 作为独立类型加入斜杠菜单，并规定引用、补充说明和发送行为。
- `settings-page`: 在设置页导航中加入“命令”分类及其作用域化管理界面。

## Impact

- 扩展宿主需要新增 Command 类型、加载器、注册表和文件管理服务，并在激活、工作区变化及设置操作后同步刷新。
- `chatPanel` 与 Webview 协议需要增加 Command 设置快照、CRUD 请求、斜杠候选元数据及消息提交字段。
- `SettingsPage`、`MessageInput`、`SlashCommandPicker` 与相关样式、测试需要支持 Command 管理和引用展示。
- Agent 输入组装需要在本地解析引用并注入 Command 正文；不引入新的运行时依赖，不执行 Command 文件中的代码。
