/**
 * 工具路由 - 收到 tool_call 时按 site 分发。
 * site=local：经注册表查找并本地执行；site=cloud：不本地执行（云端自行处理）。
 */
import type { ToolCall, ToolResult } from './types';
import type { ToolRegistry } from './toolRegistry';
import type { ToolContext } from '../tools/baseTool';
import { ProtocolError } from './errors';

export class ToolRouter {
	constructor(private readonly registry: ToolRegistry) {}

	/** 路由并执行一个工具调用。仅处理 site=local；cloud 调用抛 ProtocolError。 */
	async route(call: ToolCall, context: ToolContext): Promise<ToolResult> {
		if (call.site !== 'local') {
			// 云端工具由云端执行（tool_start/tool_end），本地不应收到其 tool_call；
			// 防御性拒绝，避免误执行。
			throw new ProtocolError(`不本地执行云端工具: ${call.tool}`);
		}
		const tool = this.registry.lookup(call.tool);
		tool.validate(call.args);
		const partial = await tool.execute(call.args, context);
		// 路由层按 call_id 盖戳，工具实现无需关心 call_id
		return { ...partial, call_id: call.call_id };
	}
}
