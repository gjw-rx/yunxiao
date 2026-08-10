/**
 * 工具路由 - 收到 tool_call 时分发，并对变更类工具做审批门。
 * permission=read：直通执行；write/execute/destructive：执行前须经 ApprovalGateway，
 *   拒绝则返回 cancelled，不执行。
 */
import type { ToolCall, ToolResult } from './types';
import type { ToolRegistry } from './toolRegistry';
import type { ToolContext, BaseTool } from '../tools/baseTool';
import type { ApprovalGateway } from './approvalGateway';
import { SecurityAudit } from './securityAudit';
import { ToolExecutionJournal, type ToolExecutionIdentity } from './toolExecutionJournal';
import * as logger from '../logger';

export class ToolRouter {
	constructor(
		private readonly registry: ToolRegistry,
		private readonly approval?: ApprovalGateway,
		private readonly audit = new SecurityAudit(),
		private readonly journal?: ToolExecutionJournal,
	) {}

	/** 路由并执行一个工具调用。 */
	async route(call: ToolCall, context: ToolContext): Promise<ToolResult> {
		logger.log(`[ToolRouter] 路由工具 ${call.tool} call_id=${call.call_id}`);
		// 查找 + 参数校验(JSON Schema + 手写 validate):失败转结构化错误,不抛未捕获异常
		let tool: BaseTool;
		try {
			tool = this.registry.lookup(call.tool);
			this.registry.validateArgs(call.tool, call.args);
		} catch (error) {
			return this.toErrorResult(call, context, error);
		}
		const audit = this.audit.audit(call, tool, context);
		if (!audit.allowed) {
			logger.notifyError(`[ToolRouter] 安全审计拒绝工具 ${call.tool}`, audit.rejection?.error);
			return audit.rejection!;
		}
		if (audit.warning) {
			context.warn?.(audit.warning);
		}

		// 审批门：write/execute/destructive 须经用户确认（read 直通）。
		// handlesOwnApproval 的工具（如 code_edit 需先 diff 预览）由其在 execute 内自行审批，路由层跳过。
		if (
			this.approval?.shouldGate(tool.permission) &&
			!tool.handlesOwnApproval
		) {
			const summary = this.buildApprovalSummary(call, tool.permission);
			const decision = tool.permission === 'destructive'
				? await this.approval.requestDestructiveApproval(
					call.tool, summary, context.sessionId, call.call_id, this.approvalScope(call, context)
				)
				: await this.approval.requestApproval(
				call.tool,
				summary,
				context.sessionId,
				call.call_id,
				this.approvalScope(call, context)
			);
			if (decision === 'deny') {
				logger.log(`[ToolRouter] 用户拒绝执行工具 ${call.tool}`);
				return {
					call_id: call.call_id,
					status: 'cancelled',
					error: '用户拒绝执行',
				};
			}
		}

		if (tool.permission === 'read' || !this.journal) {
			try {
				const partial = tool.governResult(await tool.execute(call.args, context), context);
				return { ...partial, call_id: call.call_id };
			} catch (error) {
				return this.toErrorResult(call, context, error);
			}
		}

		const identity = this.executionIdentity(call, context);
		const receipt = await this.journal.begin(identity, call.tool);
		if (receipt.kind === 'completed') {
			return receipt.result;
		}
		if (receipt.kind === 'unknown') {
			return {
				call_id: call.call_id,
				status: 'error',
				error: '本地工具执行结果未知，禁止自动重放',
				metadata: { retryable: false, execution_state: 'unknown' },
			};
		}

		try {
			const partial = tool.governResult(await tool.execute(call.args, context), context);
			const result = { ...partial, call_id: call.call_id };
			if (!context.abortSignal?.aborted) {
				await this.journal.complete(identity, result);
			}
			logger.log(`[ToolRouter] 工具 ${call.tool} 执行成功 status=${result.status}`);
			return result;
		} catch (error) {
			const result = this.toErrorResult(call, context, error);
			if (!context.abortSignal?.aborted) {
				await this.journal.complete(identity, result);
			}
			return result;
		}
	}

	/**
	 * 统一异常转结构化失败结果:仅保留 error.message(不含堆栈),堆栈只入日志不弹窗;
	 * 中断(abortSignal)返回 cancelled,不自动重放;其余返回 error + retryable:false(重试决策交给模型)。
	 */
	private toErrorResult(call: ToolCall, context: ToolContext, error: unknown): ToolResult {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(
			`[ToolRouter] 工具 ${call.tool} 执行失败 - call_id=${call.call_id}, error=${message}`,
			error instanceof Error ? error.stack ?? '' : '',
		);
		if (context.abortSignal?.aborted) {
			logger.log(`[ToolRouter] 工具 ${call.tool} 已中断,返回 cancelled`);
			return {
				call_id: call.call_id,
				status: 'cancelled',
				error: '工具执行已中断',
			};
		}
		return {
			call_id: call.call_id,
			status: 'error',
			error: message,
			metadata: { retryable: false },
		};
	}

	/** 仅明确声明可并行的只读工具允许在同一轮并发执行。 */
	canRunInParallel(call: ToolCall): boolean {
		const tool = this.registry.lookup(call.tool);
		return tool.permission === 'read' && tool.schema.canParallel === true;
	}

	/** 是否为本地注册工具。云端工具返回 false。 */
	isLocalTool(name: string): boolean {
		return this.registry.has(name);
	}

	/** 构造审批提示摘要：工具名 + 权限 + 参数。 */
	private buildApprovalSummary(
		call: ToolCall,
		permission: string
	): string {
		const argsJson = JSON.stringify(call.args);
		return `工具 ${call.tool}（${permission} 权限）将执行：\n${argsJson}`;
	}

	/** Run ID 不可用的旧流以会话 ID 隔离回执。 */
	private executionIdentity(call: ToolCall, context: ToolContext): ToolExecutionIdentity {
		return { scopeId: context.runId ?? context.sessionId ?? 'unknown-session', callId: call.call_id };
	}

	/** 从受本地路径守卫约束的调用参数构造最小审批范围。 */
	private approvalScope(call: ToolCall, context: ToolContext): { workspaceId: string; resourcePattern: string } {
		const resource = ['path', 'from', 'to', 'cwd']
			.map((key) => call.args[key])
			.find((value): value is string => typeof value === 'string') ?? '*';
		return { workspaceId: context.workspaceRoots.join('|'), resourcePattern: resource };
	}
}
