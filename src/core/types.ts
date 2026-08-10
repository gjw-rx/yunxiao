/**
 * 共享类型契约 - Phase 1 本地工具调用基础设施的核心类型。
 * 后续所有模块（注册表、协议层、会话状态机、工具实现）均依赖此文件。
 */

/** 工具权限级别。Phase 1 仅使用 read；write/execute/destructive 留待 Phase 2+ 审批网关。 */
export type Permission = 'read' | 'write' | 'execute' | 'destructive';

/** 工具结果状态。 */
export type ToolCallStatus = 'success' | 'error' | 'cancelled';

/** 工具调用生命周期状态（会话状态机用）。 */
export type ToolLifecycleState = 'pending' | 'running' | 'success' | 'error' | 'cancelled';

/** 单次本地运行生命周期状态。 */
export type RunLifecycleState =
	| 'running'
	| 'completed'
	| 'cancelled'
	| 'failed'
	| 'disconnected';

/** 运行状态变更事件 payload。 */
export interface RunStateChangePayload {
	readonly generation: number;
	readonly state: RunLifecycleState;
	readonly error?: string;
}

/** 本地执行的工具调用请求。 */
export interface ToolCall {
	readonly call_id: string;
	readonly tool: string;
	readonly args: Record<string, unknown>;
}

/** 工具结果可选元数据。 */
export interface ToolResultMetadata {
	readonly affected_files?: string[];
	readonly diff?: string;
	readonly duration_ms?: number;
	/** 终端命令退出码（terminal_exec 填充）。 */
	readonly exitCode?: number;
	/** git commit 短 SHA（git_commit 填充）。 */
	readonly sha?: string;
	/** 结果是否可由 Agent 在调整策略后有限重试。缺省为 false。 */
	readonly retryable?: boolean;
	/** 结果在本地或云端因预算被裁剪。 */
	readonly truncated?: boolean;
	/** 结果中的高置信度敏感值已被脱敏。 */
	readonly redacted?: boolean;
	/** 本地执行已开始但结果未确认，禁止自动重放。 */
	readonly execution_state?: 'unknown';
	/** code_edit 预览所依据的文件内容版本。 */
	readonly base_version?: string;
	/** code_edit 成功写入后的文件内容版本。 */
	readonly applied_version?: string;
}

/** 本地执行后回传云端的工具结果。 */
export interface ToolResult {
	readonly call_id: string;
	readonly status: ToolCallStatus;
	readonly result?: string;
	readonly error?: string;
	readonly metadata?: ToolResultMetadata;
}

/** 工具 schema：声明工具元数据，用于注册、路由与转换为 LLM 工具定义。 */
export interface ToolSchema {
	readonly name: string;
	readonly description: string;
	/** JSON Schema 描述工具参数。 */
	readonly parameters: Record<string, unknown>;
	readonly permissions: Permission;
	/** 可与其他只读工具并行执行；默认 false。 */
	readonly canParallel?: boolean;
}

// ── 事件 payload 类型 ──

/** tool_call 事件 data。 */
export interface ToolCallEventData {
	readonly call_id: string;
	readonly tool: string;
	readonly args: Record<string, unknown>;
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

/** token 用量（run_status=completed 时存在） */
export interface TokenUsage {
	readonly prompt_tokens: number;
	readonly completion_tokens: number;
	readonly total_tokens: number;
	/** 思考 token 数（provider 提供时存在） */
	readonly reasoning_tokens?: number;
}

/** token 数字来源标记：真实 usage 或估算 */
export type TokenSource = 'usage' | 'estimated';

/**
 * 每步/每轮的 token 账：真实 usage + 四类拆分（思考/工具调用/模型回复/用户输入）。
 * 四类之和与总量自洽：总量 = prompt+completion（权威），上下文 = prompt − 用户输入。
 */
export interface TokenBreakdown {
	/** 思考（优先 usage.reasoning_tokens，缺失时估算） */
	readonly reasoning: number;
	/** 工具调用（对 toolCall.name+arguments 估算） */
	readonly tool_calls: number;
	/** 模型回复（completion − reasoning − 工具调用估算，clamp ≥ 0） */
	readonly model_output: number;
	/** 用户输入（分摊法：按估算占比分摊 prompt_tokens） */
	readonly user_input: number;
	/** 上下文（system prompt + 历史 + 工具定义）= prompt_tokens − user_input，非四类之一 */
	readonly context: number;
}

/** token 用量事件 payload */
export interface TokenUsageEventPayload {
	readonly token_usage: TokenUsage;
	readonly input_length: number;
	/** 四类拆分（本步） */
	readonly breakdown?: TokenBreakdown;
	/** 拆分数字的来源标记（usage 或 estimated，缺省按字段分别判断） */
	readonly source?: TokenSource;
}

/** 会话级 token 汇总 payload（run 结束时通过 session_token_usage 事件推送） */
export interface SessionTokenUsagePayload {
	/** 会话累计总量 = Σ(各步 prompt + completion) */
	readonly total_tokens: number;
	/** 四类拆分（会话累计） */
	readonly breakdown: TokenBreakdown;
	/** 本 run 新增 token 数（便于前端增量展示） */
	readonly delta_tokens: number;
}
