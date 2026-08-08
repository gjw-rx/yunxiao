/**
 * 消息存储 - 内存存储 + VSCode workspaceState 持久化。
 * 管理会话历史消息的增删查改，支持 compaction 检查点和 1000 条上限。
 */
import type { Message, InputMessage, CompactionMessage } from './types';

/** workspaceState 接口（与 vscode.Memento 兼容，便于测试注入） */
export interface WorkspaceState {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

const STATE_KEY = 'yunxiaoAgent.messages';
const MAX_MESSAGES = 1000;

export class MessageStore {
	private readonly store = new Map<string, Message[]>();
	private readonly state?: WorkspaceState;

	constructor(state?: WorkspaceState) {
		this.state = state;
		if (state) {
			this.restore(state);
		}
	}

	/** 追加消息，分配递增 seq，自动持久化。 */
	append(sessionId: string, message: InputMessage): Message {
		let messages = this.store.get(sessionId);
		if (!messages) {
			messages = [];
			this.store.set(sessionId, messages);
		}
		const seq = messages.length > 0 ? messages[messages.length - 1].seq + 1 : 0;
		const stored = { ...message, seq } as Message;
		messages.push(stored);
		if (messages.length > MAX_MESSAGES) {
			messages.shift();
		}
		this.persist();
		return stored;
	}

	/** 返回全部消息（seq 升序）。无 session 返回空数组。 */
	loadHistory(sessionId: string): Message[] {
		return this.store.get(sessionId) ?? [];
	}

	/** 返回最新 CompactionMessage 或 null。 */
	getCompactionPoint(sessionId: string): CompactionMessage | null {
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

	/** 清空 session 消息并持久化。 */
	clear(sessionId: string): void {
		this.store.delete(sessionId);
		this.persist();
	}

	/** 删除 seq 之后的消息并持久化。 */
	deleteMessagesAfter(sessionId: string, seq: number): void {
		const messages = this.store.get(sessionId);
		if (!messages) {
			return;
		}
		const idx = messages.findIndex((m) => m.seq > seq);
		if (idx === -1) {
			return;
		}
		messages.length = idx;
		this.persist();
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
