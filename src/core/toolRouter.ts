/**
 * 工具路由 - 收到 tool_call 时按 site 分发，并对变更类工具做审批门。
 * site=local：经注册表查找并本地执行；site=cloud：不本地执行（云端自行处理）。
 * permission=read：直通执行；write/execute/destructive：执行前须经 ApprovalGateway，
 *   拒绝则返回 cancelled，不执行。本地以工具自身 permission 为准，不依赖云端 require_approval（防御纵深）。
 */
import type { ToolCall, ToolResult } from './types';
import type { ToolRegistry } from './toolRegistry';
import type { ToolContext } from '../tools/baseTool';
import type { ApprovalGateway } from './approvalGateway';
import { ProtocolError } from './errors';
import { SecurityAudit } from './securityAudit';

export class ToolRouter {
	constructor(
		private readonly registry: ToolRegistry,
		private readonly approval?: ApprovalGateway,
		private readonly audit = new SecurityAudit()
	) {}

	/** 路由并执行一个工具调用。仅处理 site=local；cloud 调用抛 ProtocolError。 */
	async route(call: ToolCall, context: ToolContext): Promise<ToolResult> {
		if (call.site !== 'local') {
			// 云端工具由云端执行（tool_start/tool_end），本地不应收到其 tool_call；
			// 防御性拒绝，避免误执行。
			throw new ProtocolError(`不本地执行云端工具: ${call.tool}`);
		}
		const tool = this.registry.lookup(call.tool);
		tool.validate(call.args);
		const audit = this.audit.audit(call, tool, context);
		if (!audit.allowed) {
			return audit.rejection!;
		}
		if (audit.warning) {
			context.warn?.(audit.warning);
		}

		// 审批门：write/execute/destructive 须经用户确认（read 直通）。
		// handlesOwnApproval 的工具（如 code.edit 需先 diff 预览）由其在 execute 内自行审批，路由层跳过。
		if (
			this.approval?.shouldGate(tool.permission) &&
			!tool.handlesOwnApproval
		) {
			const summary = this.buildApprovalSummary(call, tool.permission);
			const decision = tool.permission === 'destructive'
				? await this.approval.requestDestructiveApproval(
					call.tool, summary, context.sessionId, call.call_id
				)
				: await this.approval.requestApproval(
				call.tool,
				summary,
				context.sessionId,
				call.call_id
			);
			if (decision === 'deny') {
				return {
					call_id: call.call_id,
					status: 'cancelled',
					error: '用户拒绝执行',
				};
			}
		}

		const partial = tool.governResult(await tool.execute(call.args, context), context);
		// 路由层按 call_id 盖戳，工具实现无需关心 call_id
		return { ...partial, call_id: call.call_id };
	}

	/** 仅明确声明可并行的只读本地工具允许在同一轮并发执行。 */
	canRunInParallel(call: ToolCall): boolean {
		if (call.site !== 'local') {
			return false;
		}
		const tool = this.registry.lookup(call.tool);
		return tool.permission === 'read' && tool.schema.canParallel === true;
	}

	/** 构造审批提示摘要：工具名 + 权限 + 参数。 */
	private buildApprovalSummary(
		call: ToolCall,
		permission: string
	): string {
		const argsJson = JSON.stringify(call.args);
		return `工具 ${call.tool}（${permission} 权限）将执行：\n${argsJson}`;
	}
}
