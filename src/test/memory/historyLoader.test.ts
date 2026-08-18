import * as assert from 'assert';
import { MessageStore } from '../../memory/messageStore';
import { loadHistoryForLLM } from '../../memory/historyLoader';
import type { LLMMessage } from '../../llm/types';

describe('HistoryLoader', () => {
	describe('无 compaction', () => {
		it('加载全部消息并转换为 LLMMessage[]', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'hello' });
			store.append('s1', { role: 'assistant', content: 'hi there' });

			const result = loadHistoryForLLM('s1', store);
			assert.strictEqual(result.length, 2);
			assert.strictEqual(result[0].role, 'user');
			assert.strictEqual(result[0].content, 'hello');
			assert.strictEqual(result[1].role, 'assistant');
			assert.strictEqual(result[1].content, 'hi there');
		});

		it('空 session 返回空数组', () => {
			const store = new MessageStore();
			const result = loadHistoryForLLM('nonexistent', store);
			assert.deepStrictEqual(result, []);
		});
	});

	describe('有 compaction 检查点', () => {
		it('从 compaction 检查点开始加载（firstKeptSeq 边界）', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'old1' });
			store.append('s1', { role: 'assistant', content: 'old2' });
			// compaction 在 seq=2，firstKeptSeq=3（保留 seq>=3 的消息原文）
			store.append('s1', { role: 'compaction', summary: 'Summary text', firstKeptSeq: 3 });
			store.append('s1', { role: 'user', content: 'new1' });
			store.append('s1', { role: 'assistant', content: 'new2' });

			const result = loadHistoryForLLM('s1', store);
			// 应为 [system(summary), user(new1), assistant(new2)]
			assert.strictEqual(result.length, 3);
			assert.strictEqual(result[0].role, 'system');
			assert.strictEqual(result[0].content, 'Summary text');
			assert.strictEqual(result[1].role, 'user');
			assert.strictEqual(result[1].content, 'new1');
			assert.strictEqual(result[2].role, 'assistant');
			assert.strictEqual(result[2].content, 'new2');
		});

		it('compaction 携带边界内消息作为尾部原文', () => {
			const store = new MessageStore();
			const user0 = store.append('s1', { role: 'user', content: 'old1' });
			const assistant1 = store.append('s1', { role: 'assistant', content: 'old2' });
			// compaction 在 seq=2，firstKeptSeq=1：保留 seq>=1 的消息（old2 及之后）
			store.append('s1', { role: 'compaction', summary: 'Summary', firstKeptSeq: 1 });
			const after3 = store.append('s1', { role: 'user', content: 'after' });

			const result = loadHistoryForLLM('s1', store);
			// 应为 [system(summary), assistant(old2), user(after)]
			assert.strictEqual(result.length, 3);
			assert.strictEqual(result[0].role, 'system');
			assert.strictEqual(result[0].content, 'Summary');
			assert.strictEqual(result[1].role, 'assistant');
			assert.strictEqual(result[1].content, 'old2');
			assert.strictEqual(result[2].role, 'user');
			assert.strictEqual(result[2].content, 'after');
			void user0; void assistant1; void after3;
		});

		it('compaction 边界之后无消息时只返回 system 消息', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'old1' });
			store.append('s1', { role: 'compaction', summary: 'Just summary', firstKeptSeq: 1 });

			const result = loadHistoryForLLM('s1', store);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].role, 'system');
			assert.strictEqual(result[0].content, 'Just summary');
		});
	});

	describe('消息类型转换', () => {
		it('user 消息 attachments 内联到 content', () => {
			const store = new MessageStore();
			store.append('s1', {
				role: 'user',
				content: 'read this',
				attachments: [{ path: '/a.ts', content: 'console.log(1)', mimeType: 'text/plain' }],
			});

			const result = loadHistoryForLLM('s1', store);
			assert.strictEqual(result.length, 1);
			assert.ok(result[0].content.includes('read this'));
			assert.ok(result[0].content.includes('console.log(1)'));
			assert.ok(result[0].content.includes('/a.ts'));
		});

		it('user 消息无 attachments 时 content 不变', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'plain text' });

			const result = loadHistoryForLLM('s1', store);
			assert.strictEqual(result[0].content, 'plain text');
		});

		it('assistant 消息保留 toolCalls', () => {
			const store = new MessageStore();
			store.append('s1', {
				role: 'assistant',
				content: '',
				toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"/a.ts"}' }],
			});
			store.append('s1', { role: 'tool', toolCallId: 'call_1', content: 'file content' });

			const result = loadHistoryForLLM('s1', store);
			const assistantMsg = result[0] as { toolCalls?: unknown[] };
			assert.strictEqual(result[0].role, 'assistant');
			assert.strictEqual(result[0].content, '');
			// toolCalls 应被保留
			assert.ok(assistantMsg.toolCalls);
			assert.strictEqual(assistantMsg.toolCalls!.length, 1);
		});

		it('tool 消息保留 toolCallId 和 content', () => {
			const store = new MessageStore();
			store.append('s1', {
				role: 'assistant',
				content: '',
				toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{}' }],
			});
			store.append('s1', {
				role: 'tool',
				toolCallId: 'call_1',
				content: 'file content here',
			});

			const result = loadHistoryForLLM('s1', store);
			const toolMsg = result[1] as { role: string; toolCallId: string; content: string };
			assert.strictEqual(toolMsg.role, 'tool');
			assert.strictEqual(toolMsg.toolCallId, 'call_1');
			assert.strictEqual(toolMsg.content, 'file content here');
		});

		it('system 消息直接转换', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'system', content: 'You are a helper.' });

			const result = loadHistoryForLLM('s1', store);
			assert.strictEqual(result[0].role, 'system');
			assert.strictEqual(result[0].content, 'You are a helper.');
		});
	});
});
