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
		it('从 compaction 检查点开始加载', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: 'old1' });
			store.append('s1', { role: 'assistant', content: 'old2' });
			// compaction 在 seq=1
			store.append('s1', { role: 'compaction', summary: 'Summary text', recentContext: [] });
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

		it('compaction 携带 recentContext 时展开', () => {
			const store = new MessageStore();
			// 先创建一些消息作为 recentContext
			const recentUser = store.append('s1', { role: 'user', content: 'recent user' });
			const recentAssistant = store.append('s1', { role: 'assistant', content: 'recent assistant' });
			// compaction 携带 recentContext
			store.append('s1', {
				role: 'compaction',
				summary: 'Summary',
				recentContext: [recentUser, recentAssistant],
			});
			store.append('s1', { role: 'user', content: 'after' });

			const result = loadHistoryForLLM('s1', store);
			// 应为 [system(summary), user(recent), assistant(recent), user(after)]
			assert.strictEqual(result.length, 4);
			assert.strictEqual(result[0].role, 'system');
			assert.strictEqual(result[0].content, 'Summary');
			assert.strictEqual(result[1].role, 'user');
			assert.strictEqual(result[1].content, 'recent user');
			assert.strictEqual(result[2].role, 'assistant');
			assert.strictEqual(result[2].content, 'recent assistant');
			assert.strictEqual(result[3].role, 'user');
			assert.strictEqual(result[3].content, 'after');
		});

		it('compaction 空 recentContext 只返回 system 消息', () => {
			const store = new MessageStore();
			store.append('s1', { role: 'compaction', summary: 'Just summary', recentContext: [] });

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

			const result = loadHistoryForLLM('s1', store);
			assert.strictEqual(result[0].role, 'assistant');
			assert.strictEqual(result[0].content, '');
			// toolCalls 应被保留
			const assistantMsg = result[0] as { toolCalls?: unknown[] };
			assert.ok(assistantMsg.toolCalls);
			assert.strictEqual(assistantMsg.toolCalls!.length, 1);
		});

		it('tool 消息保留 toolCallId 和 content', () => {
			const store = new MessageStore();
			store.append('s1', {
				role: 'tool',
				toolCallId: 'call_1',
				content: 'file content here',
			});

			const result = loadHistoryForLLM('s1', store);
			assert.strictEqual(result[0].role, 'tool');
			const toolMsg = result[0] as { toolCallId: string; content: string };
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
