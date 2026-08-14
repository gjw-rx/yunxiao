/**
 * MCP Tool Adapter — 将单个 MCP 工具 catalog entry 桥接为本地 BaseTool。
 *
 * 职责：
 * - 持有不可变 catalog entry（exposedName ↔ serverId/nativeToolName 映射）
 * - 持有 Manager 引用（用于路由调用），不持有 Secret/Transport
 * - schema 由 convertMcpToolToSchema 从 catalog entry 转换
 * - execute 调用 Manager.callTool，使用原始工具名与参数，透传 AbortSignal
 * - 结果经 BaseTool.governResult 统一脱敏/截断
 *
 * 安全约定：Adapter 不持有 Secret/Transport，凭据由 Manager 装配后传入 Connection。
 * Transport、URL、command、headers、env 均不来自模型参数。
 */
import { BaseTool, type ToolContext, type ToolExecutionResult } from '../tools/baseTool';
import { convertMcpToolToSchema } from './toolSchemaAdapter';
import type { McpToolCatalogEntry } from './types';
import type { ToolSchema } from '../core/types';

/**
 * Manager 接口：Adapter 只依赖此接口，不依赖完整 Manager 实现。
 *
 * @param serverId MCP Server ID
 * @param nativeToolName Server 端原始工具名
 * @param args 经本地校验的参数
 * @param signal AgentLoop AbortSignal
 * @returns 归一化结果（不含 call_id）
 */
export interface McpToolAdapterManager {
	callTool(serverId: string, nativeToolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult>;
}

/**
 * 单个 MCP 工具的本地适配器。
 *
 * 继承 BaseTool，由 ToolRegistry 通过 registerOwnerTools 批量注册。
 * Manager 在 Server 连接成功后为每个 discovered tool 创建 Adapter 实例。
 */
export class McpToolAdapter extends BaseTool {
	private readonly _entry: McpToolCatalogEntry;
	private readonly _manager: McpToolAdapterManager;
	private readonly _schema: ToolSchema;

	/**
	 * @param entry 不可变 catalog entry（exposedName ↔ 原始工具名映射）
	 * @param manager Manager 引用（路由调用到正确的 Server Connection）
	 */
	constructor(entry: McpToolCatalogEntry, manager: McpToolAdapterManager) {
		super();
		this._entry = entry;
		this._manager = manager;
		this._schema = convertMcpToolToSchema(entry);
	}

	/** 工具元数据（由 ToolRegistry 用于注册与 LLM 工具定义转换）。 */
	get schema(): ToolSchema {
		return this._schema;
	}

	/**
	 * 执行 MCP 工具调用：使用原始工具名与参数，透传 AbortSignal，结果经 governResult 治理。
	 *
	 * @param args 经本地 JSON Schema 校验后的参数
	 * @param context ToolContext（含 abortSignal 等）
	 * @returns 归一化并治理后的结果（不含 call_id）
	 */
	async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
		const result = await this._manager.callTool(
			this._entry.serverId,
			this._entry.nativeToolName,
			args,
			context.abortSignal,
		);
		// 结果经 BaseTool.governResult 统一脱敏/截断
		return this.governResult(result, context);
	}
}
