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

	describe('deleteMessage', () => {
		it('删除非注入用户消息级联删除整个 turn', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'u1' });           // seq 0
			store.append('s1', { role: 'assistant', content: 'a1' });      // seq 1
			store.append('s1', { role: 'user', content: 'u2' });           // seq 2
			store.append('s1', { role: 'assistant', content: 'a2' });      // seq 3
			store.deleteMessage('s1', 0);
			assert.deepStrictEqual(store.loadHistory('s1').map((m) => m.seq), [2, 3]);
		});

		it('注入消息不截断删除级联', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'u1' });                              // seq 0
			store.append('s1', { role: 'user', content: 'injected', injected: true });       // seq 1
			store.append('s1', { role: 'assistant', content: 'a1' });                        // seq 2
			store.append('s1', { role: 'user', content: 'u2' });                             // seq 3
			store.deleteMessage('s1', 0);
			assert.deepStrictEqual(store.loadHistory('s1').map((m) => m.seq), [3]);
		});

		it('删除带工具调用的助手消息级联删除其工具结果', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'u1' });
			store.append('s1', {
				role: 'assistant',
				content: 'a',
				toolCalls: [
					{ id: 'c1', name: 'fs_read_file', arguments: '{}' },
					{ id: 'c2', name: 'fs_read_file', arguments: '{}' },
				],
			});
			store.append('s1', { role: 'tool', toolCallId: 'c1', content: 'r1' });
			store.append('s1', { role: 'tool', toolCallId: 'c2', content: 'r2' });
			store.append('s1', { role: 'assistant', content: 'final' });
			store.deleteMessage('s1', 1);
			assert.deepStrictEqual(store.loadHistory('s1').map((m) => m.seq), [0, 4]);
		});

		it('删除工具结果消息并清理孤立工具调用', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'u1' });
			store.append('s1', {
				role: 'assistant',
				content: 'a',
				toolCalls: [
					{ id: 'c1', name: 'x', arguments: '{}' },
					{ id: 'c2', name: 'y', arguments: '{}' },
				],
			});
			store.append('s1', { role: 'tool', toolCallId: 'c1', content: 'r1' });
			store.append('s1', { role: 'tool', toolCallId: 'c2', content: 'r2' });
			store.deleteMessage('s1', 2);
			const history = store.loadHistory('s1');
			assert.deepStrictEqual(history.map((m) => m.seq), [0, 1, 3]);
			const assistant = history.find((m) => m.seq === 1);
			const toolCalls = assistant && 'toolCalls' in assistant
				? (assistant as { toolCalls: Array<{ id: string }> }).toolCalls.map((tc) => tc.id)
				: [];
			assert.deepStrictEqual(toolCalls, ['c2']);
		});

		it('删除唯一工具结果后删除空助手消息', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'u1' });
			store.append('s1', { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: '{}' }] });
			store.append('s1', { role: 'tool', toolCallId: 'c1', content: 'r1' });
			store.deleteMessage('s1', 2);
			assert.deepStrictEqual(store.loadHistory('s1').map((m) => m.seq), [0]);
		});

		it('删除 compaction 消息', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'u1' });
			store.append('s1', { role: 'compaction', summary: 's', recentContext: [] });
			store.append('s1', { role: 'user', content: 'u2' });
			store.deleteMessage('s1', 1);
			assert.deepStrictEqual(store.loadHistory('s1').map((m) => m.seq), [0, 2]);
		});

		it('不存在 seq 为无操作', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'u1' });
			store.deleteMessage('s1', 100);
			assert.strictEqual(store.loadHistory('s1').length, 1);
		});

		it('删除后持久化到 workspaceState', () => {
			const state = createMockState();
			const store = new MessageStore(state);
			store.append('s1', { role: 'user', content: 'u1' });       // seq 0
			store.append('s1', { role: 'assistant', content: 'a1' });  // seq 1
			store.deleteMessage('s1', 0);
			const persisted = state.data['yunxiaoAgent.messages'] as Record<string, Message[]>;
			assert.strictEqual(persisted['s1'].length, 0);
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
