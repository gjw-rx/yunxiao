/**
 * 共享类型契约 - Phase 1 本地工具调用基础设施的核心类型。
 * 后续所有模块（注册表、协议层、会话状态机、工具实现）均依赖此文件。
 */

/** 工具执行位置：本地执行 or 云端执行。 */
export type ExecutionSite = 'local' | 'cloud';

/** 工具权限级别。Phase 1 仅使用 read；write/execute/destructive 留待 Phase 2+ 审批网关。 */
export type Permission = 'read' | 'write' | 'execute' | 'destructive';

/** 工具结果状态。 */
export type ToolCallStatus = 'success' | 'error' | 'cancelled';

/** 工具调用生命周期状态（会话状态机用）。 */
export type ToolLifecycleState = 'pending' | 'running' | 'success' | 'error';

/** 云端下发的工具调用请求。 */
export interface ToolCall {
	readonly call_id: string;
	readonly tool: string;
	readonly args: Record<string, unknown>;
	readonly site: ExecutionSite;
	readonly require_approval?: boolean;
}

/** 工具结果可选元数据。 */
export interface ToolResultMetadata {
	readonly affected_files?: string[];
	readonly diff?: string;
	readonly duration_ms?: number;
	/** 终端命令退出码（terminal.exec 填充）。 */
	readonly exitCode?: number;
	/** git commit 短 SHA（git.commit 填充）。 */
	readonly sha?: string;
}

/** 本地执行后回传云端的工具结果。 */
export interface ToolResult {
	readonly call_id: string;
	readonly status: ToolCallStatus;
	readonly result?: string;
	readonly error?: string;
	readonly metadata?: ToolResultMetadata;
}

/** 工具 schema：声明工具元数据，用于注册、路由与上报云端。 */
export interface ToolSchema {
	readonly name: string;
	readonly description: string;
	/** JSON Schema 描述工具参数。 */
	readonly parameters: Record<string, unknown>;
	readonly permissions: Permission;
	readonly site: ExecutionSite;
}

// ── SSE 事件 payload 类型 ──

/** tool_call 事件 data。 */
export interface ToolCallEventData {
	readonly call_id: string;
	readonly tool: string;
	readonly args: Record<string, unknown>;
	readonly site: ExecutionSite;
	readonly require_approval?: boolean;
}

/** plan 事件 data。 */
export interface PlanEventData {
	readonly steps: string[];
}

/** progress 事件 data。 */
export interface ProgressEventData {
	readonly message: string;
	readonly current?: number;
	readonly total?: number;
}
