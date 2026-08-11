/**
 * AI SDK 流适配器测试 - 验证 fullStream part → LLMEvent 归一化。
 *
 * 覆盖（Task 2.4 / 4.1）：
 * 1. text-delta / reasoning-delta → textDelta / reasoningDelta
 * 2. tool-call → toolCall（完整参数 JSON 序列化）
 * 3. finish → 一次权威 usage + finish（忽略中间 step usage，不重复记账）
 * 4. usage 缺失时 finish 不产生 usage 事件
 * 5. error → error；abort → 无事件
 * 6. usage 含 cache 明细时透传 cacheReadTokens / cacheWriteTokens
 * 7. tool-input-* / start-step 等协议内部 part 不泄漏到现有事件
 */
import * as assert from 'assert';
import { mapStreamPart, normalizeUsage } from '../../llm/aiSdkStreamAdapter';
import type { LLMEvent } from '../../llm/types';
import type { TextStreamPart } from 'ai';

/** 构造一个 TextStreamPart，方便测试按真实 shape 传参 */
function part(type: string, data: Record<string, unknown>): TextStreamPart<Record<string, never>> {
	return { type, ...data } as TextStreamPart<Record<string, never>>;
}

describe('mapStreamPart', () => {
	it('text-delta → textDelta', () => {
		const events = mapStreamPart(part('text-delta', { id: '1', text: 'hello' }), { usageEmitted: false });
		assert.deepStrictEqual(events, [{ type: 'textDelta', text: 'hello' }]);
	});

	it('reasoning-delta → reasoningDelta', () => {
		const events = mapStreamPart(part('reasoning-delta', { id: '1', text: '思考中' }), { usageEmitted: false });
		assert.deepStrictEqual(events, [{ type: 'reasoningDelta', text: '思考中' }]);
	});

	it('tool-call → toolCall，input 对象序列化为 arguments', () => {
		const events = mapStreamPart(
			part('tool-call', { toolCallId: 'call_1', toolName: 'fs_read_file', input: { path: '/tmp/a.ts' } }),
			{ usageEmitted: false },
		);
		assert.strictEqual(events.length, 1);
		const e = events[0] as { type: string; id: string; name: string; arguments: string };
		assert.strictEqual(e.type, 'toolCall');
		assert.strictEqual(e.id, 'call_1');
		assert.strictEqual(e.name, 'fs_read_file');
		assert.strictEqual(e.arguments, '{"path":"/tmp/a.ts"}');
	});

	it('finish → 一次权威 usage + finish（totalUsage 完整时）', () => {
		const state = { usageEmitted: false };
		const events = mapStreamPart(
			part('finish', {
				finishReason: 'stop',
				totalUsage: {
					inputTokens: 100,
					outputTokens: 50,
					totalTokens: 150,
					inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: undefined, cacheWriteTokens: undefined },
					outputTokenDetails: { textTokens: 30, reasoningTokens: 20 },
				},
			}),
			state,
		);
		assert.strictEqual(events.length, 2);
		const usage = events[0] as { type: string; inputTokens: number; outputTokens: number; reasoningTokens?: number; totalTokens?: number };
		assert.strictEqual(usage.type, 'usage');
		assert.strictEqual(usage.inputTokens, 100);
		assert.strictEqual(usage.outputTokens, 50);
		assert.strictEqual(usage.totalTokens, 150);
		assert.strictEqual(usage.reasoningTokens, 20);
		assert.strictEqual((events[1] as { type: string; reason: string }).reason, 'stop');
		assert.strictEqual(state.usageEmitted, true, 'usage 只应发一次');
	});

	it('连续两次 finish 不重复发 usage（usageEmitted 标记生效）', () => {
		const state = { usageEmitted: true };
		const events = mapStreamPart(
			part('finish', {
				finishReason: 'stop',
				totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			}),
			state,
		);
		assert.strictEqual(events.length, 1);
		assert.strictEqual((events[0] as { type: string }).type, 'finish');
	});

	it('usage 缺失时 finish 只产生 finish，不发明造 usage', () => {
		const events = mapStreamPart(part('finish', { finishReason: 'stop' }), { usageEmitted: false });
		assert.strictEqual(events.length, 1);
		assert.strictEqual((events[0] as { type: string }).type, 'finish');
	});

	it('finish reason: tool-calls → tool_use', () => {
		const events = mapStreamPart(part('finish', { finishReason: 'tool-calls' }), { usageEmitted: false });
		assert.strictEqual((events[0] as { reason: string }).reason, 'tool_use');
	});

	it('finish reason: length → length', () => {
		const events = mapStreamPart(part('finish', { finishReason: 'length' }), { usageEmitted: false });
		assert.strictEqual((events[0] as { reason: string }).reason, 'length');
	});

	it('finish reason: content-filter 等 → stop（与 legacy 一致）', () => {
		const events = mapStreamPart(part('finish', { finishReason: 'content-filter' }), { usageEmitted: false });
		assert.strictEqual((events[0] as { reason: string }).reason, 'stop');
	});

	it('error part → error 事件', () => {
		const events = mapStreamPart(part('error', { error: new Error('boom') }), { usageEmitted: false });
		assert.deepStrictEqual(events, [{ type: 'error', error: 'boom' }]);
	});

	it('abort part → 无事件（取消不算错误）', () => {
		const events = mapStreamPart(part('abort', {}), { usageEmitted: false });
		assert.deepStrictEqual(events, []);
	});

	it('cache 明细存在时 usage 透传 cacheReadTokens / cacheWriteTokens', () => {
		const events = mapStreamPart(
			part('finish', {
				finishReason: 'stop',
				totalUsage: {
					inputTokens: 100,
					outputTokens: 50,
					totalTokens: 150,
					inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 0 },
					outputTokenDetails: { textTokens: 50, reasoningTokens: 0 },
				},
			}),
			{ usageEmitted: false },
		);
		const usage = events[0] as { type: string; cacheReadTokens?: number; cacheWriteTokens?: number };
		assert.strictEqual(usage.type, 'usage');
		assert.strictEqual(usage.cacheReadTokens, 40);
		assert.strictEqual(usage.cacheWriteTokens, 0);
	});

	it('协议内部 part（tool-input-* / start-step / finish-step）不泄漏为事件', () => {
		const state = { usageEmitted: false };
		const internal = [
			part('tool-input-start', { id: '1', toolName: 'fs_read_file' }),
			part('tool-input-delta', { id: '1', delta: '{"p' }),
			part('tool-input-end', { id: '1' }),
			part('start-step', { request: {}, warnings: [] }),
			part('finish-step', { response: {}, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' }),
			part('start', {}),
			part('text-start', { id: '1' }),
		];
		for (const p of internal) {
			const events = mapStreamPart(p, state);
			assert.deepStrictEqual(events, [], `part=${p.type} 不应产生事件`);
		}
	});
});

describe('normalizeUsage', () => {
	it('完整 usage 归一化', () => {
		const n = normalizeUsage({
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 150,
			inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 5 },
			outputTokenDetails: { textTokens: 30, reasoningTokens: 20 },
		});
		assert.deepStrictEqual(n, {
			inputTokens: 100,
			outputTokens: 50,
			reasoningTokens: 20,
			totalTokens: 150,
			cacheReadTokens: 40,
			cacheWriteTokens: 5,
		});
	});

	it('usage 缺失字段归一化为 undefined（不硬造）', () => {
		const n = normalizeUsage({
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 150,
			inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: undefined, cacheWriteTokens: undefined },
			outputTokenDetails: { textTokens: 50, reasoningTokens: undefined },
		});
		assert.deepStrictEqual(n, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
	});
});
