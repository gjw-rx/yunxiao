/**
 * 消息存储 - 内存缓存 + 持久化。
 * 管理会话历史消息的增删查改，支持 compaction 检查点和 1000 条上限。
 * 持久化后端二选一：VSCode workspaceState（旧）或 SessionFileStore（~/.yunForce JSONL 文件，新）。
 * 对外公开 API 不变，AgentLoop / HistoryLoader 无需感知后端差异。
 */
import type { Message, InputMessage, CompactionMessage, AssistantMessage } from './types';
import { SessionFileStore, type SessionMeta } from './sessionFileStore';
import * as logger from '../logger';

/** workspaceState 接口（与 vscode.Memento 兼容，便于测试注入） */
export interface WorkspaceState {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

const STATE_KEY = 'yunxiaoAgent.messages';

/** 旧 workspaceState 迁移结果统计。 */
export interface LegacyMigrationResult {
	/** 成功迁移的会话数。 */
	readonly migrated: number;
	/** 已存在文件记录而跳过的会话数。 */
	readonly skipped: number;
	/** 迁移失败的会话数。 */
	readonly failed: number;
}

/**
 * 迁移旧 workspaceState（yunxiaoAgent.messages）中的会话消息到文件归档（一次性、幂等）。
 * 已迁移的会话（索引已有条目）跳过，避免上次中断后重复追加；
 * 逐会话写入 v2 归档，全部落盘成功后再清理旧键；任一落盘失败则保留旧键（不覆盖原始数据）。
 * @param state workspaceState（伪 Memento 接口，便于测试注入）。
 * @param fileStore 文件存储。
 * @returns 迁移结果统计。
 */
export async function migrateLegacyWorkspaceState(state: WorkspaceState, fileStore: SessionFileStore): Promise<LegacyMigrationResult> {
	const legacy = state.get<Record<string, Message[]>>(STATE_KEY);
	if (!legacy || Object.keys(legacy).length === 0) {
		return { migrated: 0, skipped: 0, failed: 0 };
	}
	let attempted = 0;
	let skipped = 0;
	for (const [sessionId, messages] of Object.entries(legacy)) {
		if (fileStore.getSession(sessionId)) {
			skipped++;
			continue;
		}
		try {
			fileStore.createSession(sessionId);
			for (const m of messages) {
				fileStore.appendMessage(sessionId, m);
			}
			attempted++;
		} catch (err) {
			// 同步阶段的异常（理论上极少发生）单独记录
			logger.error(`[MessageStore] 迁移会话失败 sessionId=${sessionId}:`, err instanceof Error ? err.message : String(err));
		}
	}
	try {
		// 等待全部会话落盘（可拒绝）后再清理旧键，防止未落盘时清理导致数据丢失
		await fileStore.commit();
		await state.update(STATE_KEY, undefined);
		logger.log(`[MessageStore] 迁移旧会话数据完成 迁移=${attempted} 跳过=${skipped} 失败=0`);
		return { migrated: attempted, skipped, failed: 0 };
	} catch (err) {
		// 任一会话异步落盘失败：保留旧键（本次迁移可安全重试），不阻塞插件启动
		logger.error(`[MessageStore] 迁移落盘失败，保留旧 workspaceState 键（可重试）:`, err instanceof Error ? err.message : String(err));
		return { migrated: 0, skipped: 0, failed: attempted };
	}
}

/** 最新压缩检查点表示的有效会话上下文。 */
export interface EffectiveHistory {
	/** 最新检查点摘要；未压缩时为 null。 */
	readonly summary: string | null;
	/** 最新检查点携带的活跃任务上下文；无压缩点或旧检查点不含该字段时为 null。 */
	readonly todoContext: string | null;
	/** 应参与下一次请求或下一次压缩的原始消息。 */
	readonly messages: Message[];
}

export class MessageStore {
	private readonly store = new Map<string, Message[]>();
	private readonly state?: WorkspaceState;
	/** 文件存储后端（新）；无则退回 workspaceState/纯内存 */
	private readonly fileStore?: SessionFileStore;

	/**
	 * @param backend 持久化后端：SessionFileStore（新，JSONL 文件）或 WorkspaceState（旧，vscdb）；省略为纯内存
	 */
	constructor(backend?: WorkspaceState | SessionFileStore) {
		if (backend instanceof SessionFileStore) {
			this.fileStore = backend;
		} else {
			this.state = backend;
			if (backend) {
				this.restore(backend);
			}
		}
	}

	/** 追加消息，分配递增 seq，自动持久化。 */
	append(sessionId: string, message: InputMessage): Message {
		this.ensureLoaded(sessionId);
		let messages = this.store.get(sessionId);
		if (!messages) {
			messages = [];
			this.store.set(sessionId, messages);
		}
		const seq = messages.length > 0 ? messages[messages.length - 1].seq + 1 : 0;
		const stored = { ...message, seq } as Message;
		messages.push(stored);
		if (this.fileStore) {
			// 延迟创建：会话索引无条目（空会话，从未落盘）时先建立记录，再追加首条消息。
			// 保证「新建会话」不产生记录，只有真正有内容的会话才会写入索引与 JSONL 文件。
			if (!this.fileStore.getSession(sessionId)) {
				this.fileStore.createSession(sessionId);
				logger.log(`[MessageStore] 首条消息延迟建立会话记录 sessionId=${sessionId}`);
			}
			// 归档层不再按 MAX_MESSAGES 截断：原始记录全部保留，仅由投影层限制展示/发送数量
			this.fileStore.appendMessage(sessionId, stored);
		} else {
			this.persist();
		}
		logger.log(`[MessageStore] 追加消息 sessionId=${sessionId} seq=${seq} 消息数=${messages.length}`);
		return stored;
	}

	/** 返回全部消息（seq 升序）。无 session 返回空数组。 */
	loadHistory(sessionId: string): Message[] {
		this.ensureLoaded(sessionId);
		const messages = this.store.get(sessionId) ?? [];
		logger.log(`[MessageStore] 加载历史 sessionId=${sessionId} 消息数=${messages.length}`);
		return messages;
	}

	/** 返回最新 CompactionMessage 或 null。 */
	getCompactionPoint(sessionId: string): CompactionMessage | null {
		this.ensureLoaded(sessionId);
		const messages = this.store.get(sessionId);
		if (!messages) {
			return null;
		}
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'compaction') {
				return messages[i] as CompactionMessage;
			}
		}
		return null;
	}

	/**
	 * 从最新压缩检查点恢复有效历史，不改写 append-only 的物理消息记录。
	 * 新检查点以 firstKeptSeq（可选 firstKeptEntryId）为保留边界：
	 * 返回边界及其后的活动路径消息原文；旧检查点（recentContext）按兼容逻辑展开。
	 * @param sessionId 会话 ID。
	 * @returns 当前生效的摘要和原始消息。
	 */
	getEffectiveHistory(sessionId: string): EffectiveHistory {
		const checkpoint = this.getCompactionPoint(sessionId);
		const allMessages = this.loadHistory(sessionId);
		if (!checkpoint) {
			return { summary: null, todoContext: null, messages: allMessages };
		}
		let messages: Message[];
		if (checkpoint.firstKeptSeq !== undefined) {
			// 新检查点：边界及之后的活动路径消息作为尾部原文（排除检查点自身）
			messages = allMessages.filter((message) => message.role !== 'compaction' && message.seq >= checkpoint.firstKeptSeq);
		} else if (checkpoint.recentContext) {
			// 旧检查点（v1）：复制近期消息原文
			messages = [
				...checkpoint.recentContext,
				...allMessages.filter((message) => message.seq > checkpoint.seq),
			];
		} else {
			messages = allMessages;
		}
		logger.log(`[MessageStore] 加载有效历史 sessionId=${sessionId} checkpointSeq=${checkpoint.seq} firstKeptSeq=${checkpoint.firstKeptSeq ?? '旧格式'} 消息数=${messages.length} todoContext=${checkpoint.todoContext ? '有' : '无'}`);
		return { summary: checkpoint.summary, todoContext: checkpoint.todoContext ?? null, messages };
	}

	/**
	 * 解析活动路径消息 seq 对应的归档 Entry ID（文件模式；内存模式返回 undefined）。
	 * 供压缩检查点写入 firstKeptEntryId 边界。
	 * @param sessionId 会话 ID
	 * @param seq 消息 seq
	 * @returns Entry ID 或 undefined
	 */
	resolveEntryId(sessionId: string, seq: number): string | undefined {
		if (!this.fileStore) {
			return undefined;
		}
		const archive = this.fileStore.readArchive(sessionId);
		for (const entry of archive.activePath) {
			if (entry.kind === 'message' && entry.payload.kind === 'message' && entry.payload.message.seq === seq) {
				return entry.id;
			}
		}
		return undefined;
	}

	/** 清空 session 消息并持久化。 */
	clear(sessionId: string): void {
		this.ensureLoaded(sessionId);
		this.store.delete(sessionId);
		if (this.fileStore) {
			this.fileStore.deleteSession(sessionId);
		} else {
			this.persist();
		}
	}

	/** 删除 seq 之后的消息并持久化。 */
	deleteMessagesAfter(sessionId: string, seq: number): void {
		this.ensureLoaded(sessionId);
		const messages = this.store.get(sessionId);
		if (!messages) {
			return;
		}
		const idx = messages.findIndex((m) => m.seq > seq);
		if (idx === -1) {
			return;
		}
		messages.length = idx;
		if (this.fileStore) {
			// 传入快照：rewriteSession 异步执行时数组可能被后续 append 修改
			this.fileStore.rewriteSession(sessionId, [...messages]);
		} else {
			this.persist();
		}
	}

	/**
	 * 回滚到指定消息之后：截断活动投影（内存），但保留原始归档 Entry——
	 * 文件模式下追加 head_update 记录持久化活动位置，不物理删除任何记录。
	 * 与 deleteMessagesAfter（物理删除）语义不同：回滚后可审计、可恢复。
	 * @param sessionId 会话 ID
	 * @param seq 保留至该 seq（该 seq 之后的消息从活动投影排除）；-1 表示清空活动路径
	 */
	rollbackMessagesAfter(sessionId: string, seq: number): void {
		this.ensureLoaded(sessionId);
		const messages = this.store.get(sessionId);
		if (!messages) {
			return;
		}
		const kept = seq < 0 ? [] : messages.filter((m) => m.seq <= seq);
		this.store.set(sessionId, kept);
		// 找回滚后最后一条保留消息的 Entry ID 作为新活动位置
		const lastKept = kept.length > 0 ? kept[kept.length - 1] : undefined;
		const headEntryId = lastKept ? this.resolveEntryId(sessionId, lastKept.seq) : null;
		if (this.fileStore) {
			this.fileStore.appendHeadUpdate(sessionId, headEntryId ?? null);
		} else {
			this.persist();
		}
		logger.log(`[MessageStore] 回滚活动位置 sessionId=${sessionId} 保留至 seq=${seq} 保留条数=${kept.length} headEntryId=${headEntryId ?? '空'}`);
	}

	/**
	 * 删除单条消息并按角色补删配对消息，保证发往模型的历史合法（tool 消息紧邻其 assistant.toolCalls）：
	 * - 删非注入 user：级联删除该 turn 内全部后续消息（到下一个非注入 user 之前）
	 * - 删带 toolCalls 的 assistant：级联删除其 toolCallId 匹配的 tool 消息
	 * - 删 tool：单条删除，并同步从对应 assistant 的 toolCalls 移除该 id；若移除后 assistant 无 toolCalls 且正文为空则一并删除
	 * @param sessionId 会话 ID
	 * @param seq 要删除的消息序号
	 */
	deleteMessage(sessionId: string, seq: number): void {
		this.ensureLoaded(sessionId);
		const messages = this.store.get(sessionId);
		if (!messages) {
			return;
		}
		const idx = messages.findIndex((m) => m.seq === seq);
		if (idx === -1) {
			logger.log(`[MessageStore] 删除消息未找到 seq=${seq} sessionId=${sessionId}`);
			return;
		}
		const target = messages[idx];
		const removed = new Set<number>([seq]);
		if (target.role === 'user' && !target.injected) {
			// 级联删除该 turn：到下一个非注入 user 消息之前
			for (let i = idx + 1; i < messages.length; i++) {
				const m = messages[i];
				if (m.role === 'user' && !m.injected) {
					break;
				}
				removed.add(m.seq);
			}
		} else if (target.role === 'assistant' && target.toolCalls && target.toolCalls.length > 0) {
			const ids = new Set(target.toolCalls.map((tc) => tc.id));
			for (const m of messages) {
				if (m.role === 'tool' && ids.has(m.toolCallId)) {
					removed.add(m.seq);
				}
			}
		} else if (target.role === 'tool') {
			// 删除 tool 消息：同步清理对应 assistant 的孤立 toolCall，避免无应答 toolCalls 使历史不合法
			const callId = target.toolCallId;
			const assistantIdx = messages.findIndex(
				(m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === callId)
			);
			if (assistantIdx !== -1) {
				const assistant = messages[assistantIdx] as AssistantMessage;
				const remaining = (assistant.toolCalls ?? []).filter((tc) => tc.id !== callId);
				if (remaining.length === 0 && !assistant.content.trim()) {
					removed.add(assistant.seq);
				} else {
					Object.assign(messages[assistantIdx], { toolCalls: remaining });
				}
			}
		}
		const filtered = messages.filter((m) => !removed.has(m.seq));
		this.store.set(sessionId, filtered);
		if (this.fileStore) {
			this.fileStore.rewriteSession(sessionId, filtered);
		} else {
			this.persist();
		}
		logger.log(`[MessageStore] 删除消息 sessionId=${sessionId} seq=${seq} 级联条数=${removed.size} 剩余=${filtered.length}`);
	}

	/** 按 seq 更新已有消息的字段（如回写 token 记账），并持久化。 */
	updateMessage(sessionId: string, seq: number, patch: Partial<InputMessage>): void {
		this.ensureLoaded(sessionId);
		const messages = this.store.get(sessionId);
		if (!messages) {
			return;
		}
		const target = messages.find((m) => m.seq === seq);
		if (!target) {
			return;
		}
		Object.assign(target, patch);
		if (this.fileStore) {
			// 传入快照：rewriteSession 异步执行时数组可能被后续 append 修改
			this.fileStore.rewriteSession(sessionId, [...messages]);
		} else {
			this.persist();
		}
	}

	/**
	 * 文件模式下创建会话（建立索引条目并设为当前会话）；无文件后端时为空操作。
	 * @param sessionId 会话 ID
	 */
	createSession(sessionId: string): void {
		this.fileStore?.createSession(sessionId);
	}

	/**
	 * 文件模式下设置当前活跃会话（用于历史会话恢复）；无文件后端时为空操作。
	 * @param sessionId 会话 ID
	 */
	setCurrentSessionId(sessionId: string): void {
		this.fileStore?.setCurrentSessionId(sessionId);
	}

	/**
	 * 文件模式下返回全部会话元数据（按 updatedAt 降序）；无文件后端返回空数组。
	 * @returns 会话元数据列表
	 */
	listSessions(): SessionMeta[] {
		return this.fileStore?.listSessions() ?? [];
	}

	/**
	 * 文件模式下持久化用户自定义标题（customTitle=true，不再被首条消息覆盖）。
	 * @param sessionId 会话 ID
	 * @param title 自定义标题
	 */
	renameSession(sessionId: string, title: string): void {
		this.fileStore?.setCustomTitle(sessionId, title);
	}

	/**
	 * 订阅会话索引变更（文件模式；新建/追加/删除/重命名/切换时触发）。
	 * @param listener 变更回调
	 * @returns 取消订阅函数
	 */
	onDidChangeSessions(listener: () => void): () => void {
		if (this.fileStore) {
			return this.fileStore.onDidChange(listener);
		}
		return () => undefined;
	}

	/**
	 * 等待全部待提交会话写入结算（文件模式；无文件后端时立即完成）。
	 * 归档失败的写入会使该 Promise 拒绝，供 AgentLoop 提交边界判断。
	 * @param sessionId 会话 ID（仅用于日志定位）
	 * @returns 提交结果（失败时拒绝）
	 */
	async commit(sessionId?: string): Promise<void> {
		if (!this.fileStore) {
			return;
		}
		await this.fileStore.commit();
		logger.log(`[MessageStore] 归档提交完成 sessionId=${sessionId ?? '全部'}`);
	} 

	/**
	 * 校验会话归档是否损坏（文件模式）。损坏时返回诊断列表，供 HistoryLoader 拒绝构建不合法上下文。
	 * @param sessionId 会话 ID
	 * @returns 归档诊断（空数组表示无损坏）
	 */
	getArchiveDiagnostics(sessionId: string): readonly string[] {
		if (!this.fileStore) {
			return [];
		}
		const raw = this.fileStore.readArchive(sessionId);
		return raw.diagnostics.map((diagnostic) => `${diagnostic.code}@${diagnostic.location}: ${diagnostic.detail}`);
	}

	/**
	 * 文件模式下从磁盘惰性加载会话消息到内存缓存（未加载过才读）。
	 * @param sessionId 会话 ID
	 */
	private ensureLoaded(sessionId: string): void {
		if (this.store.has(sessionId) || !this.fileStore) {
			return;
		}
		const messages = this.fileStore.readMessages(sessionId);
		this.store.set(sessionId, messages);
	}

	/** 持久化到 workspaceState，失败时降级为纯内存。 */
	private persist(): void {
		const data: Record<string, Message[]> = {};
		for (const [key, value] of this.store) {
			data[key] = value;
		}
		this.state?.update(STATE_KEY, data).then(undefined, () => {
			console.error('[MessageStore] workspaceState 持久化失败，降级为纯内存模式');
		});
	}

	/** 从 workspaceState 恢复数据。 */
	private restore(state: WorkspaceState): void {
		const data = state.get<Record<string, Message[]>>(STATE_KEY);
		if (data) {
			for (const [key, value] of Object.entries(data)) {
				this.store.set(key, value);
			}
		}
	}
}
