/**
 * 任务清单写入工具 - 让模型以全量快照方式维护当前会话的执行进度。
 */
import { ToolValidationError } from '../../core/errors';
import type { EventBus } from '../../core/eventBus';
import type { ToolSchema } from '../../core/types';
import * as logger from '../../logger';
import { SessionTodoStore } from '../../memory/sessionTodoStore';
import { summarizeTodos } from '../../memory/todoTypes';
import { BaseTool, type ToolContext, type ToolExecutionResult } from '../baseTool';

/** todo_write 的全量任务快照工具。 */
export class TodoWriteTool extends BaseTool {
	/** 工具注册元数据与参数约束。 */
	readonly schema: ToolSchema = {
		name: 'todo_write',
		description: '以完整任务列表覆盖当前会话的执行计划。任务仅用于展示和保持进度，不应写入对话消息。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				todos: {
					type: 'array',
					description: '按执行顺序给出的完整任务列表；传空数组可清空任务。',
					items: {
						type: 'object',
						additionalProperties: false,
						required: ['id', 'content', 'status'],
						properties: {
							id: { type: 'string', description: '任务稳定唯一标识。' },
							content: { type: 'string', description: '面向用户的简短任务说明。' },
							status: {
								type: 'string',
								enum: ['pending', 'in_progress', 'completed', 'cancelled'],
								description: '任务状态。',
							},
						},
					},
				},
			},
			required: ['todos'],
		},
		permissions: 'read',
	};

	/**
	 * @param todoStore 会话任务快照存储。
	 * @param eventBus 用于向界面广播状态变更的事件总线。
	 */
	constructor(
		private readonly todoStore: SessionTodoStore,
		private readonly eventBus: EventBus
	) {
		super();
	}

	/**
	 * 用请求中的完整任务列表替换当前会话快照，并向 Webview 广播新状态。
	 * @param args 工具调用参数。
	 * @param context 当前工具执行上下文。
	 * @returns 写入后的快照和状态汇总。
	 */
	async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
		if (!context.sessionId) {
			logger.error('[TodoWriteTool] 缺少会话 ID，拒绝写入任务快照');
			throw new ToolValidationError('todo_write 必须在有效会话中执行');
		}

		const snapshot = this.todoStore.write(context.sessionId, args.todos);
		const summary = summarizeTodos(snapshot);
		this.eventBus.emit({
			type: 'todo_state_change',
			sessionId: context.sessionId,
			payload: { snapshot, summary },
		});
		logger.log(
			`[TodoWriteTool] 任务快照已更新 sessionId=${context.sessionId} total=${summary.total} inProgress=${summary.in_progress}`
		);

		return {
			status: 'success',
			result: JSON.stringify({ todos: snapshot.todos, summary }),
		};
	}
}
