/** 上下文压缩重构的行为测试：预算、检查点及工具调用链完整性。 */
import * as assert from 'assert';
import {
	calculateCompactionThreshold,
	compactIfNeeded,
	sanitizeToolPairs,
	selectMessages,
	type CompactionConfig,
} from '../../agent/compaction';
import { MessageStore } from '../../memory/messageStore';
import { loadHistoryForLLM } from '../../memory/historyLoader';
import type { SessionTodoStore } from '../../memory/sessionTodoStore';
import type { Message } from '../../memory/types';
import type { LLMProvider } from '../../llm/types';

/** 测试用 EventBus 最小契约。 */
interface EventBusMock {
	emit(event: { type: string; sessionId: string; payload: unknown }): void;
	on(): () => void;
}

/** 创建用户消息。 @param content 消息内容。 @param seq 序号。 @returns 用户消息。 */
function userMessage(content: string, seq: number): Message {
	return { role: 'user', content, seq };
}

/** 创建 assistant 工具调用消息。 @param ids 工具调用 ID。 @param seq 序号。 @returns assistant 消息。 */
function toolCallMessage(ids: readonly string[], seq: number): Message {
	return {
		role: 'assistant',
		content: '正在调用工具',
		seq,
		toolCalls: ids.map((id) => ({ id, name: 'read_file', arguments: '{"path":"a.ts"}' })),
	};
}

/** 创建工具结果消息。 @param toolCallId 工具调用 ID。 @param seq 序号。 @returns tool 消息。 */
function toolResultMessage(toolCallId: string, seq: number): Message {
	return { role: 'tool', toolCallId, content: '工具结果'.repeat(20), seq };
}

/** 创建成功摘要的 Provider。 @returns Provider。 */
function createSummaryProvider(): LLMProvider {
	return {
		async *chatCompletion() {
			yield { type: 'textDelta' as const, text: '## 目标\n- 已压缩' };
			yield { type: 'finish' as const, reason: 'stop' as const };
		},
	};
}

/** 创建失败摘要的 Provider。 @returns Provider。 */
function createFailingSummaryProvider(): LLMProvider {
	return {
		async *chatCompletion() {
			yield { type: 'error' as const, error: '摘要服务不可用' };
		},
	};
}

/** 创建 EventBus。 @returns EventBus mock。 */
function createEventBus(): EventBusMock {
	return { emit: () => undefined, on: () => () => undefined };
}

/** 创建默认压缩配置。 @returns 压缩配置。 */
function createConfig(): CompactionConfig {
	return {
		autoEnabled: true,
		triggerPercent: 75,
		tailPercent: 20,
		maxContextTokens: 100,
		maxOutputTokens: 0,
	};
}

describe('上下文压缩预算', () => {
	it('按模型上下文减去输出预留后取 75% 阈值', () => {
		assert.strictEqual(
			calculateCompactionThreshold({ ...createConfig(), maxContextTokens: 262144, maxOutputTokens: 4096 }),
			193536,
		);
	});

	it('完整请求 token 达到阈值时自动压缩，即使历史消息 token 很少', async () => {
		const store = new MessageStore();
		store.append('request-pressure', { role: 'user', content: '短消息'.repeat(20) });
		store.append('request-pressure', { role: 'assistant', content: '短回复'.repeat(20) });

		const result = await compactIfNeeded(
			'request-pressure',
			createSummaryProvider(),
			'test-model',
			createConfig(),
			store,
			createEventBus() as never,
			{ reason: 'automatic', requestTokens: 75 },
		);

		assert.strictEqual(result.status, 'compacted');
	});
});

describe('上下文压缩工具调用完整性', () => {
	it('尾部预算命中工具结果时保留其 assistant 调用和全部结果', () => {
		const messages = [
			userMessage('很早的上下文'.repeat(50), 0),
			toolCallMessage(['call-1', 'call-2'], 1),
			toolResultMessage('call-1', 2),
			toolResultMessage('call-2', 3),
			userMessage('最新问题', 4),
		];

		const result = selectMessages(messages, 2);
		const recentCallIds = result.recent
			.filter((message) => message.role === 'assistant')
			.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? []);
		const recentResultIds = result.recent
			.filter((message) => message.role === 'tool')
			.map((message) => message.toolCallId);

		assert.deepStrictEqual(recentResultIds.sort(), recentCallIds.sort());
	});

	it('清理没有父调用的结果和没有完整结果的调用', () => {
		const result = sanitizeToolPairs([
			toolCallMessage(['complete', 'missing'], 0),
			toolResultMessage('complete', 1),
			toolResultMessage('orphan', 2),
		]);
		const assistant = result.messages.find((message) => message.role === 'assistant');
		const toolIds = result.messages
			.filter((message) => message.role === 'tool')
			.map((message) => message.toolCallId);

		assert.deepStrictEqual(assistant?.role === 'assistant' ? assistant.toolCalls?.map((call) => call.id) : [], ['complete']);
		assert.deepStrictEqual(toolIds, ['complete']);
		assert.deepStrictEqual(result.removedToolResultIds, ['orphan']);
		assert.deepStrictEqual(result.removedToolCallIds, ['missing']);
	});
});

describe('上下文压缩检查点', () => {
	it('摘要请求为模型推理和正文预留足够输出预算', async () => {
		const store = new MessageStore();
		store.append('reasoning-summary', { role: 'user', content: '需要压缩的上下文'.repeat(20) });
		store.append('reasoning-summary', { role: 'assistant', content: '旧回复'.repeat(20) });

		let maxTokens = 0;
		const provider: LLMProvider = {
			async *chatCompletion(request) {
				maxTokens = request.maxTokens ?? 0;
				yield { type: 'reasoningDelta' as const, text: '先整理要点' };
				if ((request.maxTokens ?? 0) >= 2048) {
					yield { type: 'textDelta' as const, text: '## 会话摘要\n- 已保留关键信息' };
				}
				yield { type: 'finish' as const, reason: 'stop' as const };
			},
		};

		const result = await compactIfNeeded(
			'reasoning-summary',
			provider,
			'test-model',
			createConfig(),
			store,
			createEventBus() as never,
			{ reason: 'manual', requestTokens: 0 },
		);

		assert.strictEqual(result.status, 'compacted');
		assert.strictEqual(maxTokens, 2048);
	});

	it('手动压缩在历史低于自动尾部预算时仍强制生成检查点', async () => {
		const store = new MessageStore();
		for (let index = 0; index < 45; index++) {
			store.append('manual-force', { role: 'user', content: `第 ${index} 条短消息` });
		}

		const result = await compactIfNeeded(
			'manual-force',
			createSummaryProvider(),
			'test-model',
			{ ...createConfig(), maxContextTokens: 262144, maxOutputTokens: 4096 },
			store,
			createEventBus() as never,
			{ reason: 'manual', requestTokens: 0 },
		);

		assert.strictEqual(result.status, 'compacted');
		assert.ok(store.getCompactionPoint('manual-force'));
	});

	it('摘要失败时不追加检查点', async () => {
		const store = new MessageStore();
		store.append('summary-failure', { role: 'user', content: '需要摘要的上下文'.repeat(20) });
		store.append('summary-failure', { role: 'assistant', content: '旧回复'.repeat(20) });

		const result = await compactIfNeeded(
			'summary-failure',
			createFailingSummaryProvider(),
			'test-model',
			createConfig(),
			store,
			createEventBus() as never,
			{ reason: 'manual', requestTokens: 0 },
		);

		assert.strictEqual(result.status, 'failed');
		assert.strictEqual(store.getCompactionPoint('summary-failure'), null);
	});

	it('二次压缩以最新检查点的摘要作为增量输入', async () => {
		const store = new MessageStore();
		store.append('incremental', { role: 'user', content: '第一次保留的上下文'.repeat(20) });
		store.append('incremental', {
			role: 'compaction',
			summary: '已有摘要',
			firstKeptSeq: 0,
		});
		store.append('incremental', { role: 'assistant', content: '新的进展'.repeat(20) });

		let receivedPrompt = '';
		const provider: LLMProvider = {
			async *chatCompletion(request) {
				receivedPrompt = request.messages.map((message) => message.content ?? '').join('\n');
				yield { type: 'textDelta' as const, text: '## 目标\n- 新摘要' };
				yield { type: 'finish' as const, reason: 'stop' as const };
			},
		};

		const result = await compactIfNeeded(
			'incremental',
			provider,
			'test-model',
			createConfig(),
			store,
			createEventBus() as never,
			{ reason: 'manual', requestTokens: 0 },
		);

		assert.strictEqual(result.status, 'compacted');
		assert.ok(receivedPrompt.includes('已有摘要'));
	});
});

describe('上下文压缩检查点任务上下文', () => {
	it('成功创建检查点时捕获活跃任务上下文', async () => {
		const store = new MessageStore();
		store.append('cp-context', { role: 'user', content: '短消息'.repeat(20) });
		store.append('cp-context', { role: 'assistant', content: '短回复'.repeat(20) });

		const todoStore = {
			formatActiveContext: () => '当前会话的任务进度：\n- [进行中] implement. 实现任务面板',
		} as unknown as SessionTodoStore;

		const result = await compactIfNeeded(
			'cp-context',
			createSummaryProvider(),
			'test-model',
			createConfig(),
			store,
			createEventBus() as never,
			{ reason: 'manual', requestTokens: 0 },
			todoStore,
		);

		assert.strictEqual(result.status, 'compacted');
		const checkpoint = store.getCompactionPoint('cp-context');
		assert.ok(checkpoint?.todoContext?.includes('实现任务面板'));
	});

	it('无活跃任务时不写入检查点任务上下文', async () => {
		const store = new MessageStore();
		store.append('cp-empty', { role: 'user', content: '短消息'.repeat(20) });
		store.append('cp-empty', { role: 'assistant', content: '短回复'.repeat(20) });

		const todoStore = {
			formatActiveContext: () => null,
		} as unknown as SessionTodoStore;

		const result = await compactIfNeeded(
			'cp-empty',
			createSummaryProvider(),
			'test-model',
			createConfig(),
			store,
			createEventBus() as never,
			{ reason: 'manual', requestTokens: 0 },
			todoStore,
		);

		assert.strictEqual(result.status, 'compacted');
		const checkpoint = store.getCompactionPoint('cp-empty');
		assert.strictEqual(checkpoint?.todoContext, undefined);
	});

	it('旧检查点（无任务上下文）可正常重建有效历史', async () => {
		const store = new MessageStore();
		// 旧格式检查点（recentContext 副本）按兼容逻辑展开
		store.append('legacy-cp', { role: 'compaction', summary: '旧摘要', recentContext: [userMessage('保留上下文', 0)] } as unknown as Parameters<MessageStore['append']>[1]);
		store.append('legacy-cp', { role: 'user', content: '后续消息' });

		const effective = store.getEffectiveHistory('legacy-cp');
		assert.strictEqual(effective.summary, '旧摘要');
		assert.strictEqual(effective.todoContext, null);

		const history = loadHistoryForLLM('legacy-cp', store);
		assert.deepStrictEqual(
			history.map((message) => message.content),
			['旧摘要', '保留上下文', '后续消息'],
		);
	});

	it('历史重建时检查点任务上下文与摘要相邻提供给模型', async () => {
		const store = new MessageStore();
		// 新格式检查点：firstKeptSeq=0 保留 seq>=0 的原文（保留上下文 + 后续消息）
		store.append('cp-rebuild', { role: 'user', content: '保留上下文' });
		store.append('cp-rebuild', {
			role: 'compaction',
			summary: '新摘要',
			firstKeptSeq: 0,
			todoContext: '当前会话的任务进度：\n- [进行中] implement. 实现任务面板',
		});
		store.append('cp-rebuild', { role: 'user', content: '后续消息' });

		const history = loadHistoryForLLM('cp-rebuild', store);
		assert.deepStrictEqual(
			history.slice(0, 3).map((message) => message.content),
			['新摘要', '当前会话的任务进度：\n- [进行中] implement. 实现任务面板', '保留上下文'],
		);
	});
});
