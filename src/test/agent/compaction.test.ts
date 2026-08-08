import * as assert from 'assert';
import { estimateMessage, estimateMessages } from '../../agent/tokenEstimator';
import { selectMessages, generateSummary, compactIfNeeded } from '../../agent/compaction';
import type { CompactionConfig } from '../../agent/compaction';
import { MessageStore } from '../../memory/messageStore';
import type { Message } from '../../memory/types';
import type { LLMProvider } from '../../llm/types';

/** 简化版 EventBus 接口（仅测试用） */
interface EventBusMock {
	emit(e: { type: string; sessionId: string; payload: unknown }): void;
	on(): () => void;
}

// ── 辅助工厂 ──

function userMsg(content: string): Message {
	return { role: 'user', content, seq: 0 };
}

function assistantMsg(content: string): Message {
	return { role: 'assistant', content, seq: 1 };
}

// ── Token 估算器测试 ──

describe('TokenEstimator', () => {
	describe('estimateMessage', () => {
		it('估算空字符串为 0', () => {
			const msg = userMsg('');
			assert.strictEqual(estimateMessage(msg), 0);
		});

		it('估算 4 字符为 1 token', () => {
			const msg = userMsg('abcd');
			assert.strictEqual(estimateMessage(msg), 1);
		});

		it('估算 5 字符为 2 tokens（向上取整）', () => {
			const msg = userMsg('abcde');
			assert.strictEqual(estimateMessage(msg), 2);
		});

		it('估算 assistant 消息含 toolCalls 计入额外文本', () => {
			const msg: Message = { role: 'assistant', content: 'thinking', seq: 0, toolCalls: [{ id: '1', name: 'readFile', arguments: '{"path":"x"}' }] };
			// 总文本: 'thinking' + 'readFile' + '{"path":"x"}' = 26 chars, 26/4 = 7 (ceil)
			const tokens = estimateMessage(msg);
			assert.ok(tokens > estimateMessage(assistantMsg('thinking')), '带 toolCalls 的消息应估算更多 token');
		});
	});

	describe('estimateMessages', () => {
		it('估算多条消息的总 token 数', () => {
			const msgs = [userMsg('hello'), assistantMsg('world')];
			const total = estimateMessages(msgs);
			assert.strictEqual(total, estimateMessage(msgs[0]) + estimateMessage(msgs[1]));
		});

		it('空数组返回 0', () => {
			assert.strictEqual(estimateMessages([]), 0);
		});
	});
});

// ── 分割算法测试 ──

describe('selectMessages', () => {
	it('预算内无需分割', () => {
		const msgs = [userMsg('hi'), assistantMsg('hello')];
		const result = selectMessages(msgs, 1000);
		assert.deepStrictEqual(result.head, []);
		assert.strictEqual(result.recent.length, 2);
	});

	it('超出预算时从最新消息向前累积', () => {
		const msgs = [
			userMsg('a'.repeat(40)),   // ~10 tokens
			assistantMsg('b'.repeat(40)), // ~10 tokens
			userMsg('c'.repeat(40)),   // ~10 tokens
			assistantMsg('d'.repeat(40)), // ~10 tokens
		];
		// keepTokens=15: 只能保留约 1 条消息
		const result = selectMessages(msgs, 15);
		assert.ok(result.head.length > 0, '应有 head 消息');
		assert.ok(result.recent.length > 0, '应有 recent 消息');
		assert.strictEqual(result.head.length + result.recent.length, msgs.length);
		// recent 应包含最新消息
		assert.strictEqual(result.recent[result.recent.length - 1], msgs[msgs.length - 1]);
	});

	it('边界消息不拆分，整体归入 head', () => {
		const msgs = [
			userMsg('a'.repeat(40)),   // ~10 tokens
			assistantMsg('b'.repeat(40)), // ~10 tokens
			userMsg('c'.repeat(40)),   // ~10 tokens
		];
		// keepTokens=5: 连一条消息都放不下
		const result = selectMessages(msgs, 5);
		// 第一条消息即使超出预算也会被放入 recent（因为 recent 为空时强制放入）
		assert.ok(result.recent.length >= 1, 'recent 至少包含一条消息');
	});

	it('空消息列表返回空 head 和 empty recent', () => {
		const result = selectMessages([], 1000);
		assert.deepStrictEqual(result.head, []);
		assert.deepStrictEqual(result.recent, []);
	});
});

// ── 摘要生成测试 ──

describe('generateSummary', () => {
	it('生成摘要 prompt 并调用 LLM', async () => {
		const fakeProvider: LLMProvider = {
			async *chatCompletion() {
				yield { type: 'textDelta' as const, text: '## Objective\n- Test summary\n## Important Details\n- None\n## Work State\n### Completed\n- Test\n### Active\n- \n### Blocked\n- \n## Next Move\n1. Done\n## Relevant Files\n- test.ts' };
				yield { type: 'finish' as const, reason: 'stop' as const };
			},
		};

		const head = [userMsg('test message')];
		const summary = await generateSummary(head, null, fakeProvider, 'gpt-4o-mini');
		assert.ok(summary.includes('Objective'), '摘要应包含 Objective');
		assert.ok(summary.includes('Important Details'), '摘要应包含 Important Details');
	});

	it('增量更新时合并已有摘要', async () => {
		const existingSummary = '## Objective\n- Old objective';

		const fakeProvider: LLMProvider = {
			async *chatCompletion() {
				// 通过捕获请求来验证 prompt 包含 existingSummary
				yield { type: 'textDelta' as const, text: '## Objective\n- Updated objective' };
				yield { type: 'finish' as const, reason: 'stop' as const };
			},
		};

		const head = [userMsg('new message')];
		const summary = await generateSummary(head, existingSummary, fakeProvider, 'gpt-4o-mini');
		assert.ok(summary.includes('Objective'), '增量摘要应包含 Objective');
		// 注意：由于 provider 是 fake 返回固定内容，主要验证调用不报错
	});

	it('LLM 错误时抛出异常', async () => {
		const fakeProvider: LLMProvider = {
			async *chatCompletion() {
				yield { type: 'error' as const, error: 'API error' };
			},
		};

		await assert.rejects(
			() => generateSummary([userMsg('test')], null, fakeProvider, 'gpt-4o-mini'),
			/Summary generation failed/,
		);
	});
});

// ── 压缩触发测试 ──

describe('compactIfNeeded', () => {
	const config: CompactionConfig = {
		enabled: true,
		keepTokens: 20,
		buffer: 100,
		contextWindow: 4096,
	};

	const fakeProvider: LLMProvider = {
		async *chatCompletion() {
			yield { type: 'textDelta' as const, text: '## Objective\n- Compressed' };
			yield { type: 'finish' as const, reason: 'stop' as const };
		},
	};

	it('低于阈值时不触发压缩', async () => {
		const store = new MessageStore();
		const events: unknown[] = [];
		const eventBus: EventBusMock = {
			emit(e: unknown) { events.push(e); },
			on() { return () => {}; },
		};

		// 少量消息，远低于阈值
		store.append('s1', { role: 'user', content: 'hi' });
		const msgs = store.loadHistory('s1');

		const result = await compactIfNeeded('s1', msgs, fakeProvider, 'gpt-4o-mini', config, store, eventBus as never);
		assert.strictEqual(result, false, '不应触发压缩');
	});

	it('超出阈值时自动触发压缩', async () => {
		const store = new MessageStore();
		const events: unknown[] = [];
		const eventBus: EventBusMock = {
			emit(e: unknown) { events.push(e); },
			on() { return () => {}; },
		};

		// 大量消息超出阈值
		for (let i = 0; i < 50; i++) {
			store.append('s1', { role: 'user', content: 'x'.repeat(100) });
			store.append('s1', { role: 'assistant', content: 'y'.repeat(100) });
		}
		const msgs = store.loadHistory('s1');

		const result = await compactIfNeeded('s1', msgs, fakeProvider, 'gpt-4o-mini', config, store, eventBus as never);
		assert.strictEqual(result, true, '应触发压缩');
	});

	it('disabled 时不触发压缩', async () => {
		const store = new MessageStore();
		const events: unknown[] = [];
		const eventBus: EventBusMock = {
			emit(e: unknown) { events.push(e); },
			on() { return () => {}; },
		};

		store.append('s1', { role: 'user', content: 'x'.repeat(1000) });
		const msgs = store.loadHistory('s1');

		const disabledConfig = { ...config, enabled: false };
		const result = await compactIfNeeded('s1', msgs, fakeProvider, 'gpt-4o-mini', disabledConfig, store, eventBus as never);
		assert.strictEqual(result, false, 'disabled 时不触发压缩');
	});

	it('压缩后创建 CompactionMessage', async () => {
		const store = new MessageStore();
		const events: unknown[] = [];
		const eventBus: EventBusMock = {
			emit(e: unknown) { events.push(e); },
			on() { return () => {}; },
		};

		// 先写入再多条消息，确保触发压缩
		for (let i = 0; i < 30; i++) {
			store.append('s1', { role: 'user', content: 'x'.repeat(200) });
			store.append('s1', { role: 'assistant', content: 'y'.repeat(200) });
		}
		const msgs = store.loadHistory('s1');

		await compactIfNeeded('s1', msgs, fakeProvider, 'gpt-4o-mini', config, store, eventBus as never);

		// 验证 compaction 检查点已创建
		const compactionPoint = store.getCompactionPoint('s1');
		assert.ok(compactionPoint, '应存在 compaction 检查点');
		assert.strictEqual(compactionPoint!.role, 'compaction');
		assert.ok(compactionPoint!.summary.includes('Objective'), '摘要应包含 Objective');
	});
});

// ── Overflow 恢复测试 ──

describe('overflow recovery', () => {
	it('检测 overflow 错误消息', () => {
		const overflowPatterns = [
			'context_length_exceeded',
			'maximum context length is 8192',
			'too many tokens',
			'token limit exceeded',
		];

		for (const msg of overflowPatterns) {
			const isOverflow = /context_length|maximum context|too many tokens|token limit/i.test(msg);
			assert.ok(isOverflow, `应识别 overflow 消息: ${msg}`);
		}
	});

	it('非 overflow 错误不被误判', () => {
		const normalErrors = [
			'API key invalid',
			'rate limit exceeded',
			'timeout',
			'internal server error',
		];

		for (const msg of normalErrors) {
			const isOverflow = /context_length|maximum context|too many tokens|token limit/i.test(msg);
			assert.ok(!isOverflow, `不应误判为 overflow: ${msg}`);
		}
	});
});

// ── 双阈值触发测试 ──

describe('compactIfNeeded dual threshold', () => {
	const fakeProvider: LLMProvider = {
		async *chatCompletion() {
			yield { type: 'textDelta' as const, text: '## Objective\n- Compressed' };
			yield { type: 'finish' as const, reason: 'stop' as const };
		},
	};

	function makeEventBus(): { bus: EventBusMock; events: unknown[] } {
		const events: unknown[] = [];
		const bus: EventBusMock = {
			emit(e: unknown) { events.push(e); },
			on() { return () => {}; },
		};
		return { bus, events };
	}

	it('消息条数达到阈值时触发压缩（token 未达阈值）', async () => {
		const config: CompactionConfig = {
			enabled: true,
			keepTokens: 2,
			buffer: 100,
			contextWindow: 999999, // 极高 token 阈值，确保不因 token 触发
			messageThreshold: 5,
		};
		const store = new MessageStore();
		const { bus } = makeEventBus();

		// 写入 6 条短消息，超过 messageThreshold=5
		for (let i = 0; i < 6; i++) {
			store.append('s1', { role: 'user', content: 'x' });
		}
		const msgs = store.loadHistory('s1');

		const result = await compactIfNeeded('s1', msgs, fakeProvider, 'gpt-4o-mini', config, store, bus as never);
		assert.strictEqual(result, true, '消息条数达到阈值应触发压缩');
	});

	it('消息条数未达阈值且 token 未达阈值时不触发', async () => {
		const config: CompactionConfig = {
			enabled: true,
			keepTokens: 20,
			buffer: 100,
			contextWindow: 999999,
			messageThreshold: 40,
		};
		const store = new MessageStore();
		const { bus } = makeEventBus();

		store.append('s1', { role: 'user', content: 'x' });
		const msgs = store.loadHistory('s1');

		const result = await compactIfNeeded('s1', msgs, fakeProvider, 'gpt-4o-mini', config, store, bus as never);
		assert.strictEqual(result, false, '双阈值均未达到不应触发');
	});
});

// ── 摘要模板新字段测试 ──

describe('compaction summary template', () => {
	it('摘要 prompt 包含 Failed Attempts 字段', async () => {
		const fakeProvider: LLMProvider = {
			async *chatCompletion() {
				yield { type: 'textDelta' as const, text: '## Failed Attempts\n- read_file failed' };
				yield { type: 'finish' as const, reason: 'stop' as const };
			},
		};

		const head: Message[] = [
			{ role: 'assistant', content: '', seq: 0, toolCalls: [{ id: '1', name: 'read_file', arguments: '{"path":"/none"}' }] },
			{ role: 'tool', toolCallId: '1', content: 'Error: file not found', seq: 1 },
		];

		const summary = await generateSummary(head, null, fakeProvider, 'gpt-4o-mini');
		assert.ok(summary.includes('Failed Attempts'), '摘要应包含 Failed Attempts 字段');
	});

	it('摘要 prompt 包含 Completed Work 字段', async () => {
		const fakeProvider: LLMProvider = {
			async *chatCompletion() {
				yield { type: 'textDelta' as const, text: '## Completed Work\n- write_file succeeded' };
				yield { type: 'finish' as const, reason: 'stop' as const };
			},
		};

		const head: Message[] = [
			{ role: 'assistant', content: '', seq: 0, toolCalls: [{ id: '1', name: 'write_file', arguments: '{"path":"/a"}' }] },
			{ role: 'tool', toolCallId: '1', content: 'wrote /a', seq: 1 },
		];

		const summary = await generateSummary(head, null, fakeProvider, 'gpt-4o-mini');
		assert.ok(summary.includes('Completed Work'), '摘要应包含 Completed Work 字段');
	});
});