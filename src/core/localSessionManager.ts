/**
 * LocalSessionManager - 本地会话管理器。
 *
 * 薄包装层：管理 sessionId 映射，将消息发送委托给 AgentLoop，
 * 历史加载委托给 MessageStore。替代旧的云端 SessionManager。
 */
import { randomUUID } from 'crypto';
import type { AgentLoop } from '../agent/agentLoop';
import type { MessageStore } from '../memory/messageStore';
import type { SessionMeta } from '../memory/sessionFileStore';
import type { RollbackJournal } from './rollbackJournal';
import type { ChangeJournal } from './changeJournal';
import type { Message } from '../memory/types';
import type { CompactionResult } from '../agent/compaction';
import type { SessionPlanModeStore } from './planModeStore';
import type { SessionTodoStore } from '../memory/sessionTodoStore';
import type { EventBus } from './eventBus';
import { summarizeTodos } from '../memory/todoTypes';
import * as logger from '../logger';

/** Plan 确认执行时注入的同会话隐藏执行指令（不渲染为普通用户消息，不创建新会话）。 */
const EXECUTION_PROMPT =
	'Continue executing the approved plan. Start from the first pending or in_progress task in the todo list. ' +
	'Update task statuses with todo_write as you progress. Do not re-plan; execute the existing plan.';

/** 前端期望的历史消息格式。 */
export interface HistoryEntry {
	role: string;
	content: string;
	/** 存储层消息序号（删除/回滚时用于定位消息） */
	seq: number;
	toolCalls?: Array<{ id: string; name: string; arguments: string }>;
	toolCallId?: string;
	/** 是否为系统注入消息（step 预警等）；仅 user 消息可能为 true */
	injected?: boolean;
	/** assistant 消息的 token 账（真实 usage + 四类拆分），供历史重载后恢复展示 */
	tokenUsage?: import('../memory/types').TokenUsageSnapshot;
	/** user 消息的输入 token 分摊值（估算），供历史重载后聚合展示 */
	inputTokens?: number;
	/** 助手最终回复关联的代码变更概览。 */
	changeSet?: import('../memory/types').ChangeSetReference;
}

export class LocalSessionManager {
	private currentSessionId: string | undefined;

	constructor(
		private readonly agentLoop: AgentLoop,
		private readonly messageStore: MessageStore,
		private readonly rollbackJournal?: RollbackJournal,
		private readonly workspaceRoot?: string,
		private readonly changeJournal?: ChangeJournal,
		private readonly planModeStore?: SessionPlanModeStore,
		private readonly todoStore?: SessionTodoStore,
		private readonly eventBus?: EventBus,
	) {}

	/**
	 * 创建新会话，返回会话 ID。旧会话数据保留（不清空），仅切换当前指针。
	 * 采用延迟创建：空会话不落盘（不建立索引条目/JSONL 文件），首条消息时才由
	 * MessageStore.append 自动建立记录，保证反复「新建会话」但未发消息时不残留空会话记录。
	 */
	createSession(): string {
		const sessionId = randomUUID();
		this.currentSessionId = sessionId;
		if (this.changeJournal && this.workspaceRoot) {
			void this.changeJournal.ensureSessionBaseline(sessionId, this.workspaceRoot).catch((error) => {
				logger.error(`[SessionManager] 预热会话代码变更基线失败 sessionId=${sessionId}`, error);
			});
		}
		logger.log(`[SessionManager] 创建会话 sessionId=${sessionId}（空会话延迟落盘，发消息后建立记录）`);
		return sessionId;
	}

	/** 发送用户消息，委托给 AgentLoop.run()。 */
	sendMessage(sessionId: string, text: string): void {
		this.currentSessionId = sessionId;
		logger.log(`[SessionManager] 发送消息 sessionId=${sessionId} 文本长度=${text.length}`);
		void this.agentLoop.run(sessionId, text).catch((err) => {
			logger.notifyError('[SessionManager] AgentLoop.run 异常', err instanceof Error ? err.message : String(err));
		});
	}

	/** 取消当前会话的 Agent Loop。 */
	cancel(sessionId: string): void {
		logger.log(`[SessionManager] 取消会话 sessionId=${sessionId}`);
		this.agentLoop.cancel();
	}

	/**
	 * 手动压缩指定会话的上下文。
	 * @param sessionId 会话 ID。
	 * @returns 压缩执行结果。
	 */
	async compactContext(sessionId: string): Promise<CompactionResult> {
		logger.log(`[SessionManager] 请求手动压缩 sessionId=${sessionId}`);
		return this.agentLoop.compactContext(sessionId);
	}

	/** 加载会话历史，从 MessageStore 读取并转换为前端格式。 */
	loadHistory(sessionId: string): HistoryEntry[] {
		if (this.changeJournal && this.workspaceRoot) {
			void this.changeJournal.ensureSessionBaseline(sessionId, this.workspaceRoot).catch((error) => {
				logger.error(`[SessionManager] 加载会话时预热代码变更基线失败 sessionId=${sessionId}`, error);
			});
		}
		const messages = this.messageStore.loadHistory(sessionId);
		return messages
			.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
			.map((m) => {
				if (m.role === 'assistant' && 'toolCalls' in m && m.toolCalls) {
					return {
						role: m.role,
						content: m.content,
						seq: m.seq,
						toolCalls: m.toolCalls,
						tokenUsage: m.tokenUsage,
						...(m.changeSet ? { changeSet: m.changeSet } : {}),
					};
				}
				if (m.role === 'assistant' && 'tokenUsage' in m && m.tokenUsage) {
					return { role: m.role, content: m.content, seq: m.seq, tokenUsage: m.tokenUsage, ...(m.changeSet ? { changeSet: m.changeSet } : {}) };
				}
				if (m.role === 'assistant' && 'changeSet' in m && m.changeSet) {
					return { role: m.role, content: m.content, seq: m.seq, changeSet: m.changeSet };
				}
				if (m.role === 'tool' && 'toolCallId' in m) {
					return { role: m.role, content: m.content, seq: m.seq, toolCallId: (m as { toolCallId: string }).toolCallId };
				}
				if (m.role === 'user') {
					return {
						role: m.role,
						content: m.content,
						seq: m.seq,
						...(m.injected ? { injected: true } : {}),
						...(m.inputTokens ? { inputTokens: m.inputTokens } : {}),
					};
				}
				return { role: m.role, content: m.content, seq: m.seq };
			});
	}

	/** 返回全部会话元数据（按最近更新时间降序），供历史视图展示。 */
	listSessions(): SessionMeta[] {
		return this.messageStore.listSessions();
	}

	/**
	 * 删除会话：取消进行中的 Agent Loop 并移除存储数据（文件 + 索引 + 回滚快照）。
	 * @param sessionId 会话 ID
	 */
	deleteSession(sessionId: string): void {
		logger.log(`[SessionManager] 删除会话 sessionId=${sessionId}`);
		// 仅当删除的是当前会话时才取消 Agent Loop，避免删除历史会话打断当前会话正在进行的流式回复
		if (this.currentSessionId === sessionId) {
			this.agentLoop.cancel();
		}
		this.messageStore.clear(sessionId);
		if (this.rollbackJournal) {
			void this.rollbackJournal.clearSession(sessionId);
		}
		if (this.changeJournal) {
			void this.changeJournal.clearSession(sessionId);
		}
	}

	/**
	 * 删除单条消息（含按角色补删配对消息），持久化生效；后续请求不再包含被删内容。
	 * @param sessionId 会话 ID
	 * @param seq 消息序号
	 */
	deleteMessage(sessionId: string, seq: number): void {
		logger.log(`[SessionManager] 删除消息 sessionId=${sessionId} seq=${seq}`);
		this.messageStore.deleteMessage(sessionId, seq);
	}

	/**
	 * 回滚用户输入 turn：恢复文件到该 turn 前 → 截断消息（删除该 turn 及之后）→ 清理回滚快照，返回被回滚的输入文本。
	 * @param sessionId 会话 ID
	 * @param seq 用户消息序号
	 * @returns 被回滚的用户输入文本（供前端回填输入框）
	 * @throws 会话正在生成或目标非用户消息时抛出
	 */
	async rollbackTurn(sessionId: string, seq: number): Promise<string> {
		logger.log(`[SessionManager] 回滚会话 sessionId=${sessionId} seq=${seq}`);
		if (this.agentLoop.isRunning(sessionId)) {
			throw new Error('当前会话正在生成，请先停止后再回滚');
		}
		const messages = this.messageStore.loadHistory(sessionId);
		const target = messages.find((m) => m.role === 'user' && m.seq === seq && !m.injected);
		if (!target || target.role !== 'user') {
			throw new Error('仅可回滚用户输入消息');
		}
		if (this.workspaceRoot && this.rollbackJournal) {
			await this.rollbackJournal.restoreTurn(sessionId, seq, this.workspaceRoot);
		}
		if (this.changeJournal) {
			await this.changeJournal.clearAfterSeq(sessionId, seq);
			if (this.workspaceRoot) {
				await this.changeJournal.refreshSession(sessionId, this.workspaceRoot, seq);
			}
		}
		this.messageStore.rollbackMessagesAfter(sessionId, seq - 1);
		return target.content;
	}

	/**
	 * 持久化用户自定义会话标题（优先于默认标题展示）。
	 * 空会话采用延迟创建（索引无条目），改名时先建立索引条目，
	 * 否则 setCustomTitle 因索引无该会话而静默丢弃，且会话不会出现在历史列表。
	 * @param sessionId 会话 ID
	 * @param title 自定义标题
	 */
	renameSession(sessionId: string, title: string): void {
		if (!this.messageStore.listSessions().some((s) => s.sessionId === sessionId)) {
			this.messageStore.createSession(sessionId);
			logger.log(`[SessionManager] 空会话改名前先建立索引条目 sessionId=${sessionId}`);
		}
		this.messageStore.renameSession(sessionId, title);
		logger.log(`[SessionManager] 重命名会话 sessionId=${sessionId} 标题=${title.slice(0, 40)}`);
	}

	/**
	 * 订阅会话数据变更（新建/追加/删除/重命名/切换当前会话）。
	 * @param listener 变更回调
	 * @returns 取消订阅函数
	 */
	onDidChangeSessions(listener: () => void): () => void {
		return this.messageStore.onDidChangeSessions(listener);
	}

	/** 重置会话：取消 AgentLoop + 清空 MessageStore。 */
	reset(sessionId: string): void {
		this.agentLoop.cancel();
		this.messageStore.clear(sessionId);
	}

	/** 获取当前会话 ID。 */
	getCurrentSessionId(): string | undefined {
		return this.currentSessionId;
	}

	/** 设置当前会话 ID（用于历史会话切换），并同步到存储索引。 */
	setCurrentSessionId(sessionId: string): void {
		this.currentSessionId = sessionId;
		this.messageStore.setCurrentSessionId(sessionId);
	}

	/**
	 * 进入 Plan 模式：校验 Agent 空闲、当前阶段 normal 且无活跃 Todo 后切换为 planning。
	 * 切换不向模型发送任何消息。
	 * @param sessionId 会话 ID。
	 * @throws 会话运行中、阶段不符或存在活跃任务时抛出。
	 */
	enterPlanMode(sessionId: string): void {
		this.assertPlanDeps();
		if (this.agentLoop.isRunning(sessionId)) {
			throw new Error('当前会话正在生成，请先停止后再进入 Plan 模式');
		}
		const state = this.planModeStore!.getState(sessionId);
		if (state.stage !== 'normal') {
			throw new Error(`当前会话处于 ${state.stage} 阶段，不能开始新的规划`);
		}
		if (this.hasActiveTodos(sessionId)) {
			throw new Error('当前会话仍有未完成任务，请先完成或清空后再进入 Plan 模式');
		}
		this.planModeStore!.transition(sessionId, 'planning');
		logger.log(`[SessionManager] 进入 Plan 模式 sessionId=${sessionId}`);
	}

	/**
	 * 继续规划：从 review 恢复为 planning，保留当前 Todo 草案。
	 * @param sessionId 会话 ID。
	 * @throws 会话运行中或当前不在 review 阶段时抛出。
	 */
	continuePlanning(sessionId: string): void {
		this.assertPlanDeps();
		if (this.agentLoop.isRunning(sessionId)) {
			throw new Error('当前会话正在生成，请先停止后再继续规划');
		}
		const state = this.planModeStore!.getState(sessionId);
		if (state.stage !== 'review') {
			throw new Error(`当前会话处于 ${state.stage} 阶段，不能继续规划`);
		}
		this.planModeStore!.transition(sessionId, 'planning');
		logger.log(`[SessionManager] 继续规划 sessionId=${sessionId}`);
	}

	/**
	 * 退出 Plan 模式：回到 normal；若本轮已创建 Todo 草案则清空草案并同步 todo_state_change 事件。
	 * 未创建本轮草案时不误删旧 Todo 快照。
	 * @param sessionId 会话 ID。
	 * @throws 会话运行中或当前不在 planning/review 阶段时抛出。
	 */
	exitPlanMode(sessionId: string): void {
		this.assertPlanDeps();
		if (this.agentLoop.isRunning(sessionId)) {
			throw new Error('当前会话正在生成，请先停止后再退出 Plan 模式');
		}
		const state = this.planModeStore!.getState(sessionId);
		if (state.stage !== 'planning' && state.stage !== 'review') {
			throw new Error(`当前会话处于 ${state.stage} 阶段，不在 Plan 模式中`);
		}
		const draftCreated = state.draftCreated;
		this.planModeStore!.transition(sessionId, 'normal');
		if (draftCreated && this.todoStore) {
			const snapshot = this.todoStore.write(sessionId, []);
			this.eventBus?.emit({
				type: 'todo_state_change',
				sessionId,
				payload: { snapshot, summary: summarizeTodos(snapshot) },
			});
			logger.log(`[SessionManager] 退出 Plan 模式并清空本轮草案 sessionId=${sessionId}`);
		}
	}

	/**
	 * 确认执行计划：校验 review 阶段且有活跃 Todo，先持久化 executing，
	 * 再在同一会话启动一条不渲染为普通用户消息的隐藏执行指令（不创建新会话）。
	 * @param sessionId 会话 ID。
	 * @throws 会话运行中、阶段不符或计划无待执行任务时抛出。
	 */
	confirmExecution(sessionId: string): void {
		this.assertPlanDeps();
		if (this.agentLoop.isRunning(sessionId)) {
			throw new Error('当前会话正在生成，请先停止后再执行计划');
		}
		const state = this.planModeStore!.getState(sessionId);
		if (state.stage !== 'review') {
			throw new Error(`当前会话处于 ${state.stage} 阶段，不能执行计划`);
		}
		if (!this.hasActiveTodos(sessionId)) {
			throw new Error('当前计划没有待执行任务');
		}
		this.planModeStore!.transition(sessionId, 'executing');
		logger.log(`[SessionManager] 确认执行计划，启动隐藏执行指令 sessionId=${sessionId}`);
		void this.agentLoop.run(sessionId, EXECUTION_PROMPT, { hidden: true }).catch((err) => {
			logger.notifyError('[SessionManager] 执行指令运行异常', err instanceof Error ? err.message : String(err));
		});
	}

	/** 校验 Plan 模式依赖已装配。 @throws 未装配时抛出。 */
	private assertPlanDeps(): void {
		if (!this.planModeStore) {
			throw new Error('Plan 模式服务未装配');
		}
	}

	/** 会话是否含活跃 Todo（pending 或 in_progress）。 @param sessionId 会话 ID。 @returns 是否存在活跃任务。 */
	private hasActiveTodos(sessionId: string): boolean {
		if (!this.todoStore) {
			return false;
		}
		return this.todoStore.read(sessionId).todos.some(
			(todo) => todo.status === 'pending' || todo.status === 'in_progress'
		);
	}
}
