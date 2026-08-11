/**
 * parseSSEStream 回归测试基线 - 锁定现有 legacy parser 对 fixture 集合的事件序列。
 *
 * 目的：
 * 1. 后续 AI SDK 适配器（aiSdkStreamAdapter）必须产出与之等价的事件序列。
 * 2. 重构或升级 parseSSEStream 时，本测试是行为不变性的兜底。
 *
 * 与 streamParser.test.ts 区别：后者按行为点单测；本测试遍历 fixtures.ts 中所有 fixture
 * 做批量断言，建立"基线快照"。
 */
import * as assert from 'assert';
import { parseSSEStream } from '../../llm/streamParser';
import type { LLMEvent } from '../../llm/types';
import { STREAM_FIXTURES, type StreamFixture } from './fixtures';

/** 将字符串转换为 ReadableStream<Uint8Array> */
function toStream(text: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
}

/** 收集 AsyncGenerator 的所有事件 */
async function collectEvents(sse: string): Promise<LLMEvent[]> {
	const events: LLMEvent[] = [];
	for await (const event of parseSSEStream(toStream(sse))) {
		events.push(event);
	}
	return events;
}

/** 断言事件类型序列与 fixture 期望一致 */
function assertEventTypes(events: LLMEvent[], fixture: StreamFixture): void {
	const types = events.map((e) => e.type);
	assert.deepStrictEqual(
		types,
		fixture.expectedEventTypes,
		`fixture=${fixture.name} 事件类型序列不匹配`,
	);
}

/** 断言文本拼接、reasoning 拼接、toolCall 数量、finish reason、usage 字段 */
function assertEventPayloads(events: LLMEvent[], fixture: StreamFixture): void {
	if (fixture.expectedText !== undefined) {
		const text = events
			.filter((e) => e.type === 'textDelta')
			.map((e) => (e as { text: string }).text)
			.join('');
		assert.strictEqual(text, fixture.expectedText, `fixture=${fixture.name} 文本不匹配`);
	}
	if (fixture.expectedReasoning !== undefined) {
		const reasoning = events
			.filter((e) => e.type === 'reasoningDelta')
			.map((e) => (e as { text: string }).text)
			.join('');
		assert.strictEqual(reasoning, fixture.expectedReasoning, `fixture=${fixture.name} reasoning 不匹配`);
	}
	if (fixture.expectedToolCallCount !== undefined) {
		const toolCalls = events.filter((e) => e.type === 'toolCall');
		assert.strictEqual(
			toolCalls.length,
			fixture.expectedToolCallCount,
			`fixture=${fixture.name} toolCall 数量不匹配`,
		);
	}
	if (fixture.expectedFinishReason !== undefined) {
		const finish = events.find((e) => e.type === 'finish') as { reason: string } | undefined;
		assert.ok(finish, `fixture=${fixture.name} 缺少 finish 事件`);
		assert.strictEqual(finish.reason, fixture.expectedFinishReason, `fixture=${fixture.name} finish reason 不匹配`);
	}
	if (fixture.expectedUsage !== undefined) {
		const usage = events.find((e) => e.type === 'usage') as
			| { inputTokens: number; outputTokens: number; reasoningTokens?: number; totalTokens?: number }
			| undefined;
		assert.ok(usage, `fixture=${fixture.name} 缺少 usage 事件`);
		assert.strictEqual(usage.inputTokens, fixture.expectedUsage.inputTokens, `fixture=${fixture.name} inputTokens 不匹配`);
		assert.strictEqual(usage.outputTokens, fixture.expectedUsage.outputTokens, `fixture=${fixture.name} outputTokens 不匹配`);
		if (fixture.expectedUsage.reasoningTokens !== undefined) {
			assert.strictEqual(usage.reasoningTokens, fixture.expectedUsage.reasoningTokens, `fixture=${fixture.name} reasoningTokens 不匹配`);
		}
		if (fixture.expectedUsage.totalTokens !== undefined) {
			assert.strictEqual(usage.totalTokens, fixture.expectedUsage.totalTokens, `fixture=${fixture.name} totalTokens 不匹配`);
		}
	}
}

describe('parseSSEStream 回归基线 (fixtures)', () => {
	for (const fixture of STREAM_FIXTURES) {
		it(`fixture: ${fixture.name}`, async () => {
			const events = await collectEvents(fixture.sse);
			assertEventTypes(events, fixture);
			assertEventPayloads(events, fixture);
		});
	}
});
