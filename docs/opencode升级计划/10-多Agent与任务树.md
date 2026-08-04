# 多 Agent 与任务树

## 云效现状

插件可选择服务端 Agent，云端 Armory 可装配 Agent 配置、模型、工具和 middleware。但当前不是一个由父任务调度、带独立会话与权限边界的子 Agent 系统。

## OpenCode 做得好

OpenCode 的 `task` 工具能启动 Explore 等专长子 Agent，支持后台执行和恢复既有任务；它限制嵌套深度、派生子权限，并禁止子 Agent 获得父任务未授予的能力。

## 差距

“多 Agent 选择”不等于“多 Agent 协作”。当前缺少 task parent/child、汇总结果、取消传播、并发配额、上下文隔离和责任归属。

## 建议落点与验收

先实现只读 Explore 子任务：父 run 创建子 run，子任务只能使用 read 工具并以结构化摘要回传。随后引入角色、深度、并发和权限继承；父任务取消时子任务必须停止。
