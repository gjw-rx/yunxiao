/**
 * Hooks 运行时共享类型契约。
 *
 * 仅提供四类基础事件（session_start / pre_tool_call / post_tool_call / session_end），
 * 定义 Handler 的类别（受信任转换 / 守卫观察）、返回结果、参数转换轨迹与派发执行轨迹。
 * 第一版只允许扩展内置的受信任 Hook，不从工作区、网络、脚本路径或 npm 包加载第三方 Hook。
 */
import type { ToolResult } from '../core/types';

/** Hooks 基础事件名：系统仅提供这四类事件。 */
export type HookEventName =
	| 'session_start'
	| 'session_end'
	| 'pre_tool_call'
	| 'post_tool_call';

/**
 * Handler 类别：
 * - transform：受信任参数转换器，仅用于 pre_tool_call，可提交替换后的 args；
 * - guard：观察/显式阻断器，可返回阻断决定，其余场景仅观察。
 */
export type HookHandlerKind = 'transform' | 'guard';

/**
 * session 事件载荷：仅包含会话、运行和工作区元数据，不含完整会话历史。
 * session_start 在每次 AgentLoop 运行开始时派发，session_end 在运行以成功、错误或取消结束时派发。
 */
export interface SessionHookPayload {
	/** 会话 ID。 */
	readonly sessionId: string;
	/** 本次 Agent 运行的唯一 ID。 */
	readonly runId: string;
	/** 工作区根目录列表（元数据，不含路径守卫职责）。 */
	readonly workspaceRoots: readonly string[];
	/** 运行开始时间戳（毫秒）。 */
	readonly startedAt: number;
}

/**
 * pre_tool_call 事件载荷：在本地工具初始参数校验通过后、实际执行前派发。
 * args 为当前参数（转换链中逐步更新），originalArgs 为不可变原始参数快照。
 */
export interface PreToolCallHookPayload {
	/** 会话 ID（可能缺失）。 */
	readonly sessionId?: string;
	/** 运行 ID（可能缺失）。 */
	readonly runId?: string;
	/** 工具名。 */
	readonly tool: string;
	/** 工具调用 ID。 */
	readonly callId: string;
	/** 当前参数：初始为原始已校验参数，受信任转换器可替换。 */
	readonly args: Record<string, unknown>;
	/** 不可变原始参数（初始校验后的快照）。 */
	readonly originalArgs: Record<string, unknown>;
}

/**
 * post_tool_call 事件载荷：在工具结果完成共同结果治理（governResult）后派发，
 * result 为受治理结果而非原始无界输出，Handler 只读观察。
 */
export interface PostToolCallHookPayload {
	/** 会话 ID（可能缺失）。 */
	readonly sessionId?: string;
	/** 运行 ID（可能缺失）。 */
	readonly runId?: string;
	/** 工具名。 */
	readonly tool: string;
	/** 工具调用 ID。 */
	readonly callId: string;
	/** 受治理后的工具结果。 */
	readonly result: ToolResult;
}

/** 四类事件载荷的联合类型。 */
export type HookPayload =
	| SessionHookPayload
	| PreToolCallHookPayload
	| PostToolCallHookPayload;

/**
 * Handler 返回结果：
 * - pass：继续（观察通过或无改写）；
 * - block：显式阻断工具调用（仅 guard 可返回，取消后续处理）；
 * - transform：提交替换后的工具参数（仅 transform 可返回，且只能替换 args）。
 */
export type HookHandlerResult =
	| { readonly kind: 'pass' }
	| { readonly kind: 'block'; readonly reason: string }
	| { readonly kind: 'transform'; readonly args: Record<string, unknown> };

/** Hook Handler 契约：由扩展内置并注册到 HookManager。 */
export interface HookHandler {
	/** 唯一标识（如 rtk_terminal_transform）。 */
	readonly id: string;
	/** 监听的事件。 */
	readonly event: HookEventName;
	/** Handler 类别（transform 仅用于 pre_tool_call）。 */
	readonly kind: HookHandlerKind;
	/** 稳定优先级：数值越小越先执行（同类别内）。 */
	readonly priority: number;
	/** 单次执行的有界超时（毫秒）。 */
	readonly timeoutMs: number;
	/** 执行 Handler。 */
	handle(payload: HookPayload): Promise<HookHandlerResult>;
}

/** 一次参数转换的记录（转换轨迹，路由层据此做双重审计与展示）。 */
export interface HookTransformEntry {
	/** 执行转换的 Hook ID。 */
	readonly hookId: string;
	/** 转换后的参数。 */
	readonly args: Record<string, unknown>;
}

/**
 * pre_tool_call 派发结果：包含是否被显式阻断、转换后的最终参数与转换轨迹。
 * 无转换发生时 args 与原始参数一致，transforms 为空数组。
 */
export interface PreToolCallDispatchResult {
	/** 是否被 guard 显式阻断。 */
	readonly blocked: boolean;
	/** 阻断原因（blocked 为 true 时存在）。 */
	readonly reason?: string;
	/** 转换后的最终参数（无转换时等于原始参数）。 */
	readonly args: Record<string, unknown>;
	/** 转换轨迹（空数组表示未发生转换）。 */
	readonly transforms: readonly HookTransformEntry[];
}

/** 单个 Handler 的派发执行轨迹（用于诊断与耗时观测）。 */
export interface HookDispatchTrace {
	/** 事件名。 */
	readonly event: HookEventName;
	/** Handler ID。 */
	readonly hookId: string;
	/** 开始时间戳（毫秒）。 */
	readonly startedAt: number;
	/** 执行耗时（毫秒）。 */
	readonly durationMs: number;
	/** 执行结果：pass/block/transform 为正常；timeout/error 为失败隔离；skipped 为被阻断或总开关关闭。 */
	readonly outcome: 'pass' | 'block' | 'transform' | 'timeout' | 'error' | 'skipped';
	/** 失败时的可读错误摘要（不包含堆栈）。 */
	readonly error?: string;
}

/** Hooks 配置读取接口：HookManager 与各内置 Hook 据此决定是否执行。 */
export interface HooksConfigReader {
	/** 读取当前 Hooks 配置。 */
	get(): HooksConfig;
}

/** 版本化 Hooks 配置：插件私有用户级持久化状态。 */
export interface HooksConfig {
	/** 配置版本（当前为 1）。 */
	readonly version: 1;
	/** Hooks 运行时总开关。 */
	readonly enabled: boolean;
	/** RTK 集成配置（默认禁用，需用户显式开启）。 */
	readonly rtk: {
		/** RTK 集成启用状态。 */
		readonly enabled: boolean;
		/** RTK 可执行文件绝对路径（可选，未配置时检测不到 RTK）。 */
		readonly executablePath?: string;
	};
}

