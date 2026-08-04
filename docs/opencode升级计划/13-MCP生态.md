# MCP 生态与外部资源

## 云效现状

云端已经定义 MCP 配置、白名单和装配入口，但 `ChatModelNode` 的 MCP 收集目前为空实现/预留；插件本地工具协议也只覆盖本地执行，不提供 MCP 资源生命周期。

## OpenCode 做得好

OpenCode 有 MCP catalog，可发现并规范化 tools、resources 和 resource templates，处理命名冲突和调用超时；还实现 OAuth 回调等待与取消，属于可运营的连接层。

## 差距

仅有 MCP 配置模型不足以形成生态：连接、认证、发现、失败隔离、资源引用、权限和审计均未成为完整链路。

## 建议落点与验收

先支持一个受控的只读 MCP server：连接状态、tool/resource discovery、超时、trace 和 deny policy 全部可见。OAuth、动态 server、资源模板和企业凭据轮换放在后续阶段。
