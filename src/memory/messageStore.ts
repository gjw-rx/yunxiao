/**
 * 消息存储 - 内存缓存 + 持久化。
 * 管理会话历史消息的增删查改，支持 compaction 检查点和 1000 条上限。
 * 持久化后端二选一：VSCode workspaceState（旧）或 SessionFileStore（~/.yunForce JSONL 文件，新）。
 * 对外公开 API 不变，AgentLoop / HistoryLoader 无需感知后端差异。
 */
import type { Message, InputMessage, CompactionMessage } from './types';
import { SessionFileStore, type SessionMeta } from './sessionFileStore';
import * as logger from '../logger';

/** workspaceState 接口（与 vscode.Memento 兼容，便于测试注入） */
export interface WorkspaceState {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

const STATE_KEY = 'yunxiaoAgent.messages';
const MAX_MESSAGES = 1000;

/** 最新压缩检查点表示的有效会话上下文。 */
export interface EffectiveHistory {
	/** 最新检查点摘要；未压缩时为 null。 */
	readonly summary: string | null;
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
		let truncated = false;
		if (messages.length > MAX_MESSAGES) {
			messages.shift();
			truncated = true;
		}
		if (this.fileStore) {
			// 延迟创建：会话索引无条目（空会话，从未落盘）时先建立记录，再追加首条消息。
			// 保证「新建会话」不产生记录，只有真正有内容的会话才会写入索引与 JSONL 文件。
			if (!this.fileStore.getSession(sessionId)) {
				this.fileStore.createSession(sessionId);
				logger.log(`[MessageStore] 首条消息延迟建立会话记录 sessionId=${sessionId}`);
			}
			if (truncated) {
				// 触发上限截断时整体重写文件（否则 JSONL 无限增长、重启后读回超限）
				this.fileStore.rewriteSession(sessionId, messages);
			} else {
				// 常规追加：追加写一行 + 联动更新索引（标题/消息数/时间）
				this.fileStore.appendMessage(sessionId, stored);
			}
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
	 * @param sessionId 会话 ID。
	 * @returns 当前生效的摘要和原始消息。
	 */
	getEffectiveHistory(sessionId: string): EffectiveHistory {
		const checkpoint = this.getCompactionPoint(sessionId);
		const allMessages = this.loadHistory(sessionId);
		if (!checkpoint) {
			return { summary: null, messages: allMessages };
		}
		const messages = [
			...checkpoint.recentContext,
			...allMessages.filter((message) => message.seq > checkpoint.seq),
		];
		logger.log(`[MessageStore] 加载有效历史 sessionId=${sessionId} checkpointSeq=${checkpoint.seq} 消息数=${messages.length}`);
		return { summary: checkpoint.summary, messages };
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
			this.fileStore.rewriteSession(sessionId, messages);
		} else {
			this.persist();
		}
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
			this.fileStore.rewriteSession(sessionId, messages);
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
