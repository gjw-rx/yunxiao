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
export type ToolLifecycleState = 'pending' | 'running' | 'success' | 'error' | 'cancelled';

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
	/** 结果是否可由 Agent 在调整策略后有限重试。缺省为 false。 */
	readonly retryable?: boolean;
	/** 结果在本地或云端因预算被裁剪。 */
	readonly truncated?: boolean;
	/** 结果中的高置信度敏感值已被脱敏。 */
	readonly redacted?: boolean;
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
	/** 可与其他只读工具并行执行；默认 false。 */
	readonly canParallel?: boolean;
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

/** tool_start 事件 data（云端工具开始，run_id 用于配对 tool_end）。 */
export interface ToolStartEventData {
	readonly run_id: string;
	readonly name: string;
	readonly input: Record<string, unknown>;
	readonly tool_call_id?: string | null;
}

/** tool_end 事件 data（云端工具结束，run_id 与 tool_start 配对）。 */
export interface ToolEndEventData {
	readonly run_id: string;
	readonly name: string;
	readonly output: string;
	readonly tool_call_id?: string | null;
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
