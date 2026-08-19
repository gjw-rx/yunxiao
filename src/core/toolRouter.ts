/**
 * 工具路由 - 收到 tool_call 时分发，并对变更类工具做审批门。
 * permission=read：直通执行；write/execute/destructive：执行前须经 ApprovalGateway，
 *   拒绝则返回 cancelled，不执行。
 */
import type { ToolCall, ToolResult } from './types';
import type { ToolRegistry } from './toolRegistry';
import type { ToolContext, BaseTool } from '../tools/baseTool';
import type { ApprovalGateway } from './approvalGateway';
import type { SessionPlanModeStore } from './planModeStore';
import { SecurityAudit } from './securityAudit';
import { ToolExecutionJournal, type ToolExecutionIdentity } from './toolExecutionJournal';
import type { HookManager } from '../hook/hookManager';
import type { HookTransformEntry } from '../hook/types';
import * as logger from '../logger';

export class ToolRouter {
	constructor(
		private readonly registry: ToolRegistry,
		private readonly approval?: ApprovalGateway,
		private readonly audit = new SecurityAudit(),
		private readonly journal?: ToolExecutionJournal,
		private readonly hooks?: HookManager,
		private readonly planMode?: SessionPlanModeStore,
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

		// ── Plan 模式兜底：查找工具后、参数 Hook 与审批前应用统一会话策略，拒绝不允许的调用 ──
		// 日志记录会话 ID、阶段、工具名与 call ID，不记录敏感参数。
		if (this.planMode && context.sessionId) {
			const planState = this.planMode.getState(context.sessionId);
			if (!this.planMode.isToolAllowed(context.sessionId, tool.schema)) {
				logger.log(
					`[ToolRouter] Plan 模式拒绝工具 tool=${call.tool} sessionId=${context.sessionId} stage=${planState.stage} callId=${call.call_id}`
				);
				return {
					call_id: call.call_id,
					status: 'cancelled',
					error: `当前阶段（${planState.stage}）不允许调用工具 ${call.tool}`,
				};
			}
		}

		// 原始调用不可变快照（初始校验通过后；JSON 深拷贝，Hook 无法篡改审计对象）
		const originalArgs: Record<string, unknown> = JSON.parse(JSON.stringify(call.args)) as Record<string, unknown>;

		// ── 集中安全审计（原始调用）：在 Hook 执行前完成，防止转换篡改绕过 ──
		const auditOriginal = this.audit.audit({ ...call, args: originalArgs }, tool, context);
		if (!auditOriginal.allowed) {
			logger.notifyError(`[ToolRouter] 安全审计拒绝工具 ${call.tool}（原始参数）`, auditOriginal.rejection?.error);
			return auditOriginal.rejection!;
		}

		// ── pre_tool_call：受信任转换链 + 守卫链（转换后重新校验）──
		let finalArgs = originalArgs;
		let transforms: readonly HookTransformEntry[] = [];
		if (this.hooks) {
			const pre = await this.hooks.dispatchPreToolCall({
				sessionId: context.sessionId,
				runId: context.runId,
				tool: call.tool,
				callId: call.call_id,
				args: originalArgs,
				originalArgs,
			});
			if (pre.blocked) {
				logger.log(`[ToolRouter] Hook 显式阻断工具 ${call.tool} call_id=${call.call_id} reason=${pre.reason}`);
				return {
					call_id: call.call_id,
					status: 'cancelled',
					error: pre.reason ?? '工具调用已被 Hook 阻断',
				};
			}
			if (pre.args !== originalArgs) {
				// 转换发生：重新执行既有校验，失败则保留原始参数继续（fail-open）
				try {
					this.registry.validateArgs(call.tool, pre.args);
					finalArgs = pre.args;
					transforms = pre.transforms;
					logger.log(`[ToolRouter] Hook 转换参数已通过重新校验 tool=${call.tool} transforms=${transforms.length}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logger.log(`[ToolRouter] Hook 转换参数未通过重新校验，保留原始参数 tool=${call.tool} error=${message}`);
				}
			}
		}

		// ── 集中安全审计（最终调用）：原始与最终各自独立审计，任一拒绝均禁止执行 ──
		const auditFinal = this.audit.audit({ ...call, args: finalArgs }, tool, context);
		if (!auditFinal.allowed) {
			logger.notifyError(`[ToolRouter] 安全审计拒绝工具 ${call.tool}（最终参数）`, auditFinal.rejection?.error);
			return auditFinal.rejection!;
		}
		if (auditOriginal.warning && auditOriginal.warning !== auditFinal.warning) {
			context.warn?.(auditOriginal.warning);
		}
		if (auditFinal.warning) {
			context.warn?.(auditFinal.warning);
		}

		// 审批门：write/execute/destructive 须经用户确认（read 直通）。
		// handlesOwnApproval 的工具（如 code_edit、terminal_exec）由其在 execute 内自行审批，路由层跳过。
		if (
			this.approval?.shouldGate(tool.permission) &&
			!tool.handlesOwnApproval
		) {
			const summary = this.buildApprovalSummary(call, tool.permission, finalArgs);
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

		// 执行上下文：发生转换时注入原始/最终参数与转换轨迹，供工具展示与安全判断
		const execContext: ToolContext = transforms.length > 0
			? { ...context, callTransform: { originalArgs, finalArgs, transforms } }
			: context;

		const result = await this.runExecution(tool, finalArgs, execContext, call, context);
		if (tool.permission !== 'read' && result.status === 'success') {
			this.invalidateFileLookupCaches(context);
		}

		// ── post_tool_call：治理后的受治理结果，只读观察 ──
		await this.dispatchPostToolCall(call, context, result);
		return result;
	}

	/** 清除当前运行的文件读取与搜索缓存，避免复用已过期或已脱离上下文的工作区信息。 */
	invalidateFileLookupCaches(context: Pick<ToolContext, 'sessionId' | 'runId'>): void {
		const cacheInvalidator = (toolName: string): void => {
			if (!this.registry.has(toolName)) {
				return;
			}
			const tool = this.registry.lookup(toolName) as BaseTool & {
				invalidateRunCache?: (sessionId: string | undefined, runId: string | undefined) => void;
			};
			tool.invalidateRunCache?.(context.sessionId, context.runId);
		};
		cacheInvalidator('fs_read_file');
		cacheInvalidator('fs_search_files');
		logger.log(`[ToolRouter] 写操作后已清除文件查询缓存 sessionId=${context.sessionId ?? '未知'}, runId=${context.runId ?? '未知'}`);
	}

	/**
	 * 执行并治理工具结果（含执行台账事务），统一返回带 call_id 的结果。
	 *
	 * @param tool 已查找到的工具
	 * @param args 最终参数（可能经 Hook 转换）
	 * @param execContext 注入转换轨迹后的执行上下文
	 * @param call 原始工具调用
	 * @param context 原始路由上下文（用于 journal 与中断判断）
	 * @returns 工具执行结果
	 */
	private async runExecution(
		tool: BaseTool,
		args: Record<string, unknown>,
		execContext: ToolContext,
		call: ToolCall,
		context: ToolContext,
	): Promise<ToolResult> {
		if (tool.permission === 'read' || !this.journal) {
			try {
				const partial = tool.governResult(await tool.execute(args, execContext), context);
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
			const partial = tool.governResult(await tool.execute(args, execContext), context);
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
	 * 派发只读 post_tool_call：Hook 看到的是受治理结果而非原始无界输出。
	 * 派发失败被 HookManager 隔离，不影响工具结果返回。
	 *
	 * @param call 原始工具调用
	 * @param context 路由上下文
	 * @param result 受治理后的工具结果
	 * @returns Promise<void>
	 */
	private async dispatchPostToolCall(call: ToolCall, context: ToolContext, result: ToolResult): Promise<void> {
		if (!this.hooks) {
			return;
		}
		try {
			await this.hooks.dispatch('post_tool_call', {
				sessionId: context.sessionId,
				runId: context.runId,
				tool: call.tool,
				callId: call.call_id,
				result,
			});
		} catch (error) {
			logger.error(`[ToolRouter] post_tool_call 派发失败 tool=${call.tool}`, error);
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

	/** 构造审批提示摘要：工具名 + 权限 + 最终参数（可能经 Hook 转换）。 */
	private buildApprovalSummary(
		call: ToolCall,
		permission: string,
		args: Record<string, unknown>
	): string {
		const argsJson = JSON.stringify(args);
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
