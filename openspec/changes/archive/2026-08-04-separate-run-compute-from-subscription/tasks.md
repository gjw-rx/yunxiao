## 1. Run 事务与查询边界

- [x] 1.1 为 Run 状态事件原子提交、状态冲突和 interrupted Run 查询编写 RED 测试
- [x] 1.2 扩展 RunRepository、RunService 与 RunEventService，实现条件状态变更和状态事件同事务追加

## 2. 计算与订阅服务

- [x] 2.1 为幂等准入、后台计算、断开订阅后继续执行、失败收敛和消息归档编写 RED 测试
- [x] 2.2 实现 RunComputeService，使初始计算和工具结果续算由独立后台任务驱动并持久化协议事件
- [x] 2.3 为 sequence 补发、多订阅与终态追平编写 RED 测试，并实现 RunSubscriptionService
- [x] 2.4 在 AppState 中注册后台 Run task，提供安全的任务清理边界

## 3. v2 Run API

- [x] 3.1 为 Run 创建、幂等重试、状态读取、工具结果续算和事件 SSE 编写 API RED 测试
- [x] 3.2 新增 Run 请求/响应 schema 与 v2 views，返回稳定 run_id 和 sequence 事件信封

## 4. v1 兼容适配

- [x] 4.1 为 `/message/stream` 与 `/tool_result` 的旧协议负载、X-Run-ID 和断线行为编写回归测试
- [x] 4.2 将 v1 streaming 路由改为 Run 命令加订阅适配器，确保订阅 finally 不再驱动计算或消息归档

## 5. 验证与交接

- [x] 5.1 运行 Run/Invoke 定向测试、相关后端回归与覆盖率检查
- [x] 5.2 运行 Ruff 和 `openspec validate separate-run-compute-from-subscription --strict`
- [x] 5.3 更新跨会话执行记忆，记录改动、验证结果、未解决风险和下一 change 前置条件
