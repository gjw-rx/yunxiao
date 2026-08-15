/**
 * 会话任务状态存储 - 对会话索引中的 Todo 快照进行校验、持久化和模型上下文格式化。
 */
import { ToolValidationError } from '../core/errors';
import * as logger from '../logger';
import { SessionFileStore } from './sessionFileStore';
import type { TodoItem, TodoSnapshot, TodoStatus } from './todoTypes';

/** 单次任务计划允许的最大任务数。 */
export const MAX_TODO_ITEMS = 100;
/** 单条任务说明允许的最大字符数。 */
export const MAX_TODO_CONTENT_LENGTH = 500;
const VALID_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];

/** 会话级 Todo 持久化服务。 */
export class SessionTodoStore {
	/** @param fileStore 同 workspace 的会话文件存储。 */
	constructor(private readonly fileStore: SessionFileStore) {}

	/** 读取会话完整任务快照。 @param sessionId 会话 ID。 @returns 任务快照。 */
	read(sessionId: string): TodoSnapshot {
		const snapshot = this.fileStore.getTodoSnapshot(sessionId);
		logger.log(`[SessionTodoStore] 读取任务快照 sessionId=${sessionId} count=${snapshot.todos.length}`);
		return snapshot;
	}

	/** 校验后全量替换会话任务。 @param sessionId 会话 ID。 @param value 模型传入任务。 @returns 规范化快照。 */
	write(sessionId: string, value: unknown): TodoSnapshot {
		const snapshot = { todos: this.normalizeTodos(value) };
		this.fileStore.setTodoSnapshot(sessionId, snapshot);
		logger.log(`[SessionTodoStore] 写入任务快照 sessionId=${sessionId} count=${snapshot.todos.length}`);
		return snapshot;
	}

	/** 构建仅包含未完成任务的系统上下文。 @param sessionId 会话 ID。 @returns 上下文文本；无活跃任务时为 null。 */
	formatActiveContext(sessionId: string): string | null {
		const active = this.read(sessionId).todos.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress');
		if (active.length === 0) {
			return null;
		}
		return ['当前会话的任务进度（由本地 todo_write 工具维护）：', ...active.map((todo) => `- [${todo.status === 'in_progress' ? '进行中' : '待办'}] ${todo.id}. ${todo.content}`), '继续执行这些未完成任务；不要重复已完成任务。'].join('\n');
	}

	/** 规范化模型输入。 @param value 模型传入的 todos 值。 @returns 不可变任务数组。 */
	private normalizeTodos(value: unknown): readonly TodoItem[] {
		if (!Array.isArray(value) || value.length > MAX_TODO_ITEMS) {
			throw new ToolValidationError(`参数 todos 必须是至多 ${MAX_TODO_ITEMS} 项的数组`);
		}
		const ids = new Set<string>();
		let inProgress = 0;
		return value.map((item, index) => {
			if (!item || typeof item !== 'object' || Array.isArray(item)) {
				throw new ToolValidationError(`todos[${index}] 必须是对象`);
			}
			const record = item as Record<string, unknown>;
			const id = typeof record.id === 'string' ? record.id.trim() : '';
			const content = typeof record.content === 'string' ? record.content.trim() : '';
			const status = record.status as TodoStatus;
			if (!id || ids.has(id)) {
				throw new ToolValidationError(`todos[${index}].id 必须非空且唯一`);
			}
			if (!content || content.length > MAX_TODO_CONTENT_LENGTH) {
				throw new ToolValidationError(`todos[${index}].content 必须为 1-${MAX_TODO_CONTENT_LENGTH} 个字符`);
			}
			if (!VALID_STATUSES.includes(status)) {
				throw new ToolValidationError(`todos[${index}].status 不合法`);
			}
			ids.add(id);
			inProgress += status === 'in_progress' ? 1 : 0;
			if (inProgress > 1) {
				throw new ToolValidationError('任务列表至多允许一项 in_progress');
			}
			return { id, content, status };
		});
	}
}
