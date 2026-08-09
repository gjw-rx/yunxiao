import * as assert from 'assert';
import { parseSSEStream } from '../../llm/streamParser';
import type { LLMEvent } from '../../llm/types';

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
async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<LLMEvent[]> {
	const events: LLMEvent[] = [];
	for await (const event of parseSSEStream(stream)) {
		events.push(event);
	}
	return events;
}

describe('parseSSEStream', () => {
	it('解析文本增量', async () => {
		const sse = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
			'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
			'data: {"choices":[{"finish_reason":"stop"}]}\n\n' +
			'data: [DONE]\n\n';
		const events = await collectEvents(toStream(sse));
		const textEvents = events.filter((e) => e.type === 'textDelta');
		assert.strictEqual(textEvents.length, 2);
		assert.strictEqual((textEvents[0] as { text: string }).text, 'hello');
		assert.strictEqual((textEvents[1] as { text: string }).text, ' world');
		const finishEvent = events.find((e) => e.type === 'finish');
		assert.ok(finishEvent);
		assert.strictEqual((finishEvent as { reason: string }).reason, 'stop');
	});

	it('解析 DeepSeek 思维链增量 (reasoning_content)', async () => {
		const sse =
			'data: {"choices":[{"delta":{"reasoning_content":"先"}}]}\n\n' +
			'data: {"choices":[{"delta":{"reasoning_content":"分析"}}]}\n\n' +
			'data: {"choices":[{"delta":{"content":"最终回答"}}]}\n\n' +
			'data: {"choices":[{"finish_reason":"stop"}]}\n\n' +
			'data: [DONE]\n\n';
		const events = await collectEvents(toStream(sse));
		const reasoningEvents = events.filter((e) => e.type === 'reasoningDelta');
		assert.strictEqual(reasoningEvents.length, 2);
		assert.strictEqual((reasoningEvents[0] as { text: string }).text, '先');
		assert.strictEqual((reasoningEvents[1] as { text: string }).text, '分析');
		// 思维链与正文分离：textDelta 只含最终回答
		const textEvents = events.filter((e) => e.type === 'textDelta');
		assert.strictEqual(textEvents.length, 1);
		assert.strictEqual((textEvents[0] as { text: string }).text, '最终回答');
	});

	it('解析 OpenAI reasoning 规范思维链增量 (reasoning)', async () => {
		const sse =
			'data: {"choices":[{"delta":{"reasoning":"Let me"}}]}\n\n' +
			'data: {"choices":[{"delta":{"reasoning":" think"}}]}\n\n' +
			'data: {"choices":[{"finish_reason":"stop"}]}\n\n' +
			'data: [DONE]\n\n';
		const events = await collectEvents(toStream(sse));
		const reasoningEvents = events.filter((e) => e.type === 'reasoningDelta');
		assert.strictEqual(reasoningEvents.length, 2);
		assert.strictEqual((reasoningEvents[0] as { text: string }).text, 'Let me');
		assert.strictEqual((reasoningEvents[1] as { text: string }).text, ' think');
	});

	it('合并 tool_calls 增量片段', async () => {
		const sse =
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_"}}]}}]}\n\n' +
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"{\\"path"}}]}}]}\n\n' +
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\": \\"test.ts\\"}"}}]}}]}\n\n' +
			'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n' +
			'data: [DONE]\n\n';
		const events = await collectEvents(toStream(sse));
		const toolCallEvents = events.filter((e) => e.type === 'toolCall');
		assert.strictEqual(toolCallEvents.length, 1);
		const tc = toolCallEvents[0] as { id: string; name: string; arguments: string };
		assert.strictEqual(tc.id, 'call_1');
		assert.strictEqual(tc.name, 'read_file');
		assert.strictEqual(tc.arguments, '{"path": "test.ts"}');
		const finishEvent = events.find((e) => e.type === 'finish');
		assert.strictEqual((finishEvent as { reason: string }).reason, 'tool_use');
	});

	it('处理 [DONE] 标记不产生事件', async () => {
		const sse = 'data: [DONE]\n\n';
		const events = await collectEvents(toStream(sse));
		assert.strictEqual(events.length, 0);
	});

	it('解析 usage', async () => {
		const sse =
			'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n' +
			'data: [DONE]\n\n';
		const events = await collectEvents(toStream(sse));
		const usageEvent = events.find((e) => e.type === 'usage');
		assert.ok(usageEvent);
		assert.strictEqual((usageEvent as { inputTokens: number }).inputTokens, 100);
		assert.strictEqual((usageEvent as { outputTokens: number }).outputTokens, 50);
	});

	it('跳过无法解析的行', async () => {
		const sse =
			'data: {invalid json}\n\n' +
			'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
			'data: {"choices":[{"finish_reason":"stop"}]}\n\n' +
			'data: [DONE]\n\n';
		const events = await collectEvents(toStream(sse));
		const textEvents = events.filter((e) => e.type === 'textDelta');
		assert.strictEqual(textEvents.length, 1);
		assert.strictEqual((textEvents[0] as { text: string }).text, 'ok');
	});

	it('映射 finish_reason: length', async () => {
		const sse =
			'data: {"choices":[{"finish_reason":"length"}]}\n\n' +
			'data: [DONE]\n\n';
		const events = await collectEvents(toStream(sse));
		const finishEvent = events.find((e) => e.type === 'finish');
		assert.strictEqual((finishEvent as { reason: string }).reason, 'length');
	});

	it('处理多个 tool_calls', async () => {
		const sse =
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file"}}]}}]}\n\n' +
			'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"list_dir"}}]}}]}\n\n' +
			'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n' +
			'data: [DONE]\n\n';
		const events = await collectEvents(toStream(sse));
		const toolCallEvents = events.filter((e) => e.type === 'toolCall');
		assert.strictEqual(toolCallEvents.length, 2);
		assert.strictEqual((toolCallEvents[0] as { name: string }).name, 'read_file');
		assert.strictEqual((toolCallEvents[1] as { name: string }).name, 'list_dir');
	});
});
