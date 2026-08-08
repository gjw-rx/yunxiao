import * as assert from 'assert';
import { MessageStore, type WorkspaceState } from '../../memory/messageStore';
import type { Message, InputMessage } from '../../memory/types';

/** 简易 Memento mock */
function createMockState(): WorkspaceState & { data: Record<string, unknown> } {
	const data: Record<string, unknown> = {};
	return {
		data,
		get<T>(key: string): T | undefined {
			return data[key] as T | undefined;
		},
		update(key: string, value: unknown): Thenable<void> {
			data[key] = value;
			return Promise.resolve();
		},
	};
}

/** 模拟 update 失败的 Memento */
function createFailingState(): WorkspaceState {
	return {
		get<T>(): T | undefined {
			return undefined;
		},
		update(): Thenable<void> {
			return Promise.reject(new Error('storage full'));
		},
	};
}

describe('MessageStore', () => {
	describe('append & seq', () => {
		it('首条消息 seq=0', () => {
			const store = new MessageStore();
			const msg = store.append('s1', { role: 'user', content: 'hello' });
			assert.strictEqual(msg.seq, 0);
			assert.strictEqual(msg.role, 'user');
		});

		it('后续消息 seq 递增', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'a' });
			store.append('s1', { role: 'assistant', content: 'b' });
			const msg = store.append('s1', { role: 'user', content: 'c' });
			assert.strictEqual(msg.seq, 2);
		});

		it('不同 session 独立计数', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'a' });
			const msg2 = store.append('s2', { role: 'user', content: 'b' });
			assert.strictEqual(msg2.seq, 0);
		});
	});

	describe('loadHistory', () => {
		it('返回全部消息（seq 升序）', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'a' });
			store.append('s1', { role: 'assistant', content: 'b' });
			store.append('s1', { role: 'user', content: 'c' });
			const history = store.loadHistory('s1');
			assert.strictEqual(history.length, 3);
			assert.strictEqual(history[0].seq, 0);
			assert.strictEqual(history[2].seq, 2);
		});

		it('无 session 返回空数组', () => {
			const store = new MessageStore();
			assert.deepStrictEqual(store.loadHistory('nonexistent'), []);
		});
	});

	describe('getCompactionPoint', () => {
		it('返回最新 CompactionMessage', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'a' });
			store.append('s1', { role: 'compaction', summary: 'first', recentContext: [] });
			store.append('s1', { role: 'user', content: 'b' });
			store.append('s1', { role: 'compaction', summary: 'second', recentContext: [] });
			const point = store.getCompactionPoint('s1');
			assert.ok(point);
			assert.strictEqual(point.summary, 'second');
		});

		it('无 compaction 返回 null', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'a' });
			assert.strictEqual(store.getCompactionPoint('s1'), null);
		});

		it('无 session 返回 null', () => {
			const store = new MessageStore();
			assert.strictEqual(store.getCompactionPoint('nonexistent'), null);
		});
	});

	describe('clear', () => {
		it('清空 session 消息', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'a' });
			store.clear('s1');
			assert.deepStrictEqual(store.loadHistory('s1'), []);
		});
	});

	describe('deleteMessagesAfter', () => {
		it('删除 seq 之后的消息', () => {
			const store = new MessageStore();
			for (let i = 0; i < 10; i++) {
				store.append('s1', { role: 'user', content: String(i) });
			}
			store.deleteMessagesAfter('s1', 5);
			const history = store.loadHistory('s1');
			assert.strictEqual(history.length, 6);
			assert.strictEqual(history[5].seq, 5);
		});

		it('无匹配消息时不删除', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'a' });
			store.deleteMessagesAfter('s1', 100);
			assert.strictEqual(store.loadHistory('s1').length, 1);
		});
	});

	describe('持久化', () => {
		it('append 后持久化到 workspaceState', () => {
			const state = createMockState();
			const store = new MessageStore(state);
			store.append('s1', { role: 'user', content: 'hello' });
			const persisted = state.data['yunxiaoAgent.messages'] as Record<string, Message[]>;
			assert.ok(persisted);
			assert.strictEqual(persisted['s1'].length, 1);
			assert.strictEqual((persisted['s1'][0] as { content: string }).content, 'hello');
		});

		it('构造时从 workspaceState 恢复', () => {
			const state = createMockState();
			const store1 = new MessageStore(state);
			store1.append('s1', { role: 'user', content: 'restored' });
			// 用同一个 state 构造新 store
			const store2 = new MessageStore(state);
			const history = store2.loadHistory('s1');
			assert.strictEqual(history.length, 1);
			assert.strictEqual((history[0] as { content: string }).content, 'restored');
		});

		it('持久化失败时降级为纯内存', () => {
			const state = createFailingState();
			const store = new MessageStore(state);
			// 不应抛出异常
			store.append('s1', { role: 'user', content: 'a' });
			// 消息仍在内存中
			assert.strictEqual(store.loadHistory('s1').length, 1);
		});
	});

	describe('1000 条上限', () => {
		it('超过 1000 条时移除最旧消息', () => {
			const store = new MessageStore();
			for (let i = 0; i < 1001; i++) {
				store.append('s1', { role: 'user', content: String(i) });
			}
			const history = store.loadHistory('s1');
			assert.strictEqual(history.length, 1000);
			// 最旧的消息（seq=0）应被移除，最旧的应为 seq=1
			assert.strictEqual(history[0].seq, 1);
			// 最新的应为 seq=1000
			assert.strictEqual(history[999].seq, 1000);
		});
	});
});
