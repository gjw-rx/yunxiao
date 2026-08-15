/**
 * Runtime Parity 测试 - 使用同一组 fixtures 对比 legacy 与 AI SDK runtime 的事件序列（Task 5.1）。
 *
 * 两侧都以 fixtures.ts 的期望元数据为基准断言：
 * - legacy：parseSSEStream(fixture.sse) 产生的事件序列（回归基线）
 * - AI SDK：构造等价 fullStream parts → mapStreamPart 产生的事件序列
 *
 * 断言两边均与同一期望一致，从而证明 AI SDK 适配器不改变既有 LLM/EventBus 契约。
 */
import * as assert from 'assert';
import { parseSSEStream } from '../../llm/streamParser';
import { mapStreamPart } from '../../llm/aiSdkStreamAdapter';
import type { LLMEvent } from '../../llm/types';
import type { TextStreamPart } from 'ai';
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

/** 解析 arguments JSON 字符串用于语义比较；非法 JSON 原样返回 */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** 收集 legacy parser 事件 */
async function collectLegacy(sse: string): Promise<LLMEvent[]> {
	const events: LLMEvent[] = [];
	for await (const event of parseSSEStream(toStream(sse))) {
		events.push(event);
	}
	return events;
}

/**
 * 按 fixture 期望元数据构造等价 AI SDK fullStream parts。
 * 文本/推理各一段增量（chunk 粒度与 legacy 无关，语义等价即可）。
 */
function buildAiSdkParts(fixture: StreamFixture): TextStreamPart<Record<string, never>>[] {
	const parts: TextStreamPart<Record<string, never>>[] = [];
	if (fixture.expectedText !== undefined && fixture.expectedText.length > 0) {
		parts.push({ type: 'text-delta', id: 't', text: fixture.expectedText } as TextStreamPart<Record<string, never>>);
	}
	if (fixture.expectedReasoning !== undefined && fixture.expectedReasoning.length > 0) {
		parts.push({ type: 'reasoning-delta', id: 'r', text: fixture.expectedReasoning } as TextStreamPart<Record<string, never>>);
	}
	for (const tc of fixture.expectedToolCalls ?? []) {
		let input: unknown;
		try {
			input = JSON.parse(tc.arguments);
		} catch {
			input = {};
		}
		parts.push({
			type: 'tool-call',
			toolCallId: tc.id,
			toolName: tc.name,
			input,
		} as unknown as TextStreamPart<Record<string, never>>);
	}
	if (fixture.expectedFinishReason !== undefined) {
		const usage = fixture.expectedUsage;
		parts.push({
			type: 'finish',
			finishReason: mapToSdkFinishReason(fixture.expectedFinishReason),
			totalUsage: usage
				? {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					totalTokens: usage.totalTokens,
					inputTokenDetails: { noCacheTokens: usage.inputTokens, cacheReadTokens: undefined, cacheWriteTokens: undefined },
					outputTokenDetails: { textTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens },
				}
				: undefined,
		} as unknown as TextStreamPart<Record<string, never>>);
	}
	return parts;
}

/** 将本地 finish reason 映射回 AI SDK finishReason（用于构造 parts） */
function mapToSdkFinishReason(reason: 'stop' | 'tool_use' | 'length'): 'stop' | 'tool-calls' | 'length' {
	switch (reason) {
		case 'tool_use':
			return 'tool-calls';
		case 'length':
			return 'length';
		default:
			return 'stop';
	}
}

/** 收集 AI SDK 适配器事件 */
function collectAiSdk(fixture: StreamFixture): LLMEvent[] {
	const events: LLMEvent[] = [];
	const state = { usageEmitted: false };
	for (const part of buildAiSdkParts(fixture)) {
		events.push(...mapStreamPart(part, state));
	}
	return events;
}

/** 提取事件的关键语义：文本拼接、推理拼接、toolCall 明细、usage、finish reason */
function summarize(events: LLMEvent[]): {
	text: string;
	reasoning: string;
	toolCalls: Array<{ id: string; name: string; arguments: string }>;
	usage: Record<string, unknown> | null;
	finish: string | null;
} {
	const text = events.filter((e) => e.type === 'textDelta').map((e) => (e as { text: string }).text).join('');
	const reasoning = events.filter((e) => e.type === 'reasoningDelta').map((e) => (e as { text: string }).text).join('');
	const toolCalls = events
		.filter((e) => e.type === 'toolCall')
		.map((e) => ({ id: (e as { id: string }).id, name: (e as { name: string }).name, arguments: (e as { arguments: string }).arguments }));
	const usageEvent = events.find((e) => e.type === 'usage');
	const usage = usageEvent
		? (({ inputTokens, outputTokens, reasoningTokens, totalTokens } = usageEvent as unknown as Record<string, unknown>) => ({
			inputTokens,
			outputTokens,
			reasoningTokens,
			totalTokens,
		}))()
		: null;
	const finishEvent = events.find((e) => e.type === 'finish');
	return {
		text,
		reasoning,
		toolCalls,
		usage,
		finish: finishEvent ? (finishEvent as { reason: string }).reason : null,
	};
}

describe('Runtime Parity：legacy 与 AI SDK 事件序列对比', () => {
	for (const fixture of STREAM_FIXTURES) {
		it(`fixture: ${fixture.name}`, async () => {
			const legacy = await collectLegacy(fixture.sse);
			const aiSdk = collectAiSdk(fixture);
			const legacySummary = summarize(legacy);
			const aiSdkSummary = summarize(aiSdk);

			// 文本 / 推理 / toolCall / finish reason 两侧一致
			assert.strictEqual(aiSdkSummary.text, legacySummary.text, '文本内容不一致');
			assert.strictEqual(aiSdkSummary.reasoning, legacySummary.reasoning, '推理内容不一致');
			assert.deepStrictEqual(
				aiSdkSummary.toolCalls.map((tc) => ({ ...tc, arguments: parseJson(tc.arguments) })),
				legacySummary.toolCalls.map((tc) => ({ ...tc, arguments: parseJson(tc.arguments) })),
				'toolCall 明细不一致（arguments 按 JSON 语义比较，忽略空白差异）',
			);
			assert.strictEqual(aiSdkSummary.finish, legacySummary.finish, 'finish reason 不一致');

			// usage：两侧都为 null 或字段一致
			if (legacySummary.usage === null) {
				assert.strictEqual(aiSdkSummary.usage, null, 'legacy 无 usage 时 AI SDK 也不应产生 usage');
			} else {
				assert.ok(aiSdkSummary.usage, 'AI SDK 应产生 usage');
				assert.strictEqual(aiSdkSummary.usage.inputTokens, legacySummary.usage.inputTokens, 'inputTokens 不一致');
				assert.strictEqual(aiSdkSummary.usage.outputTokens, legacySummary.usage.outputTokens, 'outputTokens 不一致');
			}
		});
	}
});
