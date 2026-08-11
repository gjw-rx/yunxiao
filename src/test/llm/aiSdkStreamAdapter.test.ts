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

	it('cache 明细存在时 usage 透传 cacheReadTokens / cacheWriteTokens / noCacheTokens', () => {
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
		const usage = events[0] as { type: string; cacheReadTokens?: number; cacheWriteTokens?: number; noCacheTokens?: number };
		assert.strictEqual(usage.type, 'usage');
		assert.strictEqual(usage.cacheReadTokens, 40);
		assert.strictEqual(usage.cacheWriteTokens, 0);
		assert.strictEqual(usage.noCacheTokens, 60);
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
	it('完整 usage 归一化（含 noCacheTokens 透传）', () => {
		const n = normalizeUsage({
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 150,
			inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 5 },
			outputTokenDetails: { textTokens: 30, reasoningTokens: 20 },
		});
		assert.deepStrictEqual(n.usage, {
			inputTokens: 100,
			outputTokens: 50,
			reasoningTokens: 20,
			totalTokens: 150,
			cacheReadTokens: 40,
			cacheWriteTokens: 5,
			noCacheTokens: 60,
		});
		assert.deepStrictEqual(n.rejected, []);
	});

	it('usage 缺失字段归一化为 undefined（不硬造），rejected 为空', () => {
		const n = normalizeUsage({
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 150,
			inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
			outputTokenDetails: { textTokens: 50, reasoningTokens: undefined },
		});
		assert.deepStrictEqual(n.usage, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
		assert.deepStrictEqual(n.rejected, []);
	});

	it('负 reasoning（-59）→ 省略并记录拒绝，保留 input/output/total', () => {
		const n = normalizeUsage({
			inputTokens: 11583,
			outputTokens: 105,
			totalTokens: 11688,
			inputTokenDetails: { noCacheTokens: 191, cacheReadTokens: 11392, cacheWriteTokens: undefined },
			outputTokenDetails: { textTokens: 105, reasoningTokens: -59 },
		});
		assert.strictEqual(n.usage.inputTokens, 11583);
		assert.strictEqual(n.usage.outputTokens, 105);
		assert.strictEqual(n.usage.totalTokens, 11688);
		assert.strictEqual(n.usage.reasoningTokens, undefined, '负 reasoning 应省略');
		assert.strictEqual(n.usage.cacheReadTokens, 11392, '有效缓存读取应保留');
		assert.deepStrictEqual(n.rejected, [{ field: 'reasoningTokens', value: -59, reason: '非有限非负整数' }]);
	});

	it('reasoning 超过 output → 省略并记录拒绝', () => {
		const n = normalizeUsage({
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 150,
			inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: undefined, cacheWriteTokens: undefined },
			outputTokenDetails: { textTokens: 0, reasoningTokens: 60 },
		});
		assert.strictEqual(n.usage.reasoningTokens, undefined);
		assert.deepStrictEqual(n.rejected, [{ field: 'reasoningTokens', value: 60, reason: '超过上限 50' }]);
	});

	it('cacheRead 超过 input → 省略并记录拒绝，保留顶层有效字段', () => {
		const n = normalizeUsage({
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 150,
			inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 101, cacheWriteTokens: 5 },
			outputTokenDetails: { textTokens: 50, reasoningTokens: undefined },
		});
		assert.strictEqual(n.usage.inputTokens, 100);
		assert.strictEqual(n.usage.totalTokens, 150);
		assert.strictEqual(n.usage.cacheReadTokens, undefined, '超上限的 cacheRead 应省略');
		assert.strictEqual(n.usage.cacheWriteTokens, 5, '其他有效细分应保留');
		assert.strictEqual(n.usage.noCacheTokens, 0, '合法 0 应保留');
		assert.deepStrictEqual(n.rejected, [{ field: 'cacheReadTokens', value: 101, reason: '超过上限 100' }]);
	});

	it('noCacheTokens 超过 input → 省略并记录拒绝', () => {
		const n = normalizeUsage({
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 150,
			inputTokenDetails: { noCacheTokens: 120, cacheReadTokens: undefined, cacheWriteTokens: undefined },
			outputTokenDetails: { textTokens: 50, reasoningTokens: undefined },
		});
		assert.strictEqual(n.usage.noCacheTokens, undefined);
		assert.deepStrictEqual(n.rejected, [{ field: 'noCacheTokens', value: 120, reason: '超过上限 100' }]);
	});

	it('非有限数（NaN/Infinity）→ 省略并记录拒绝', () => {
		const n = normalizeUsage({
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 150,
			inputTokenDetails: { noCacheTokens: Infinity, cacheReadTokens: NaN, cacheWriteTokens: undefined },
			outputTokenDetails: { textTokens: 50, reasoningTokens: NaN },
		});
		assert.strictEqual(n.usage.reasoningTokens, undefined);
		assert.strictEqual(n.usage.cacheReadTokens, undefined);
		assert.strictEqual(n.usage.noCacheTokens, undefined);
		assert.deepStrictEqual(n.rejected, [
			{ field: 'reasoningTokens', value: NaN, reason: '非有限非负整数' },
			{ field: 'cacheReadTokens', value: NaN, reason: '非有限非负整数' },
			{ field: 'noCacheTokens', value: Infinity, reason: '非有限非负整数' },
		]);
	});

	it('合法 0 的细分全部保留（0 是有效值，非未提供）', () => {
		const n = normalizeUsage({
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
		});
		assert.deepStrictEqual(n.usage, {
			inputTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
			totalTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			noCacheTokens: 0,
		});
		assert.deepStrictEqual(n.rejected, []);
	});

	it('provider total ≠ input+output 时原样保留（AI SDK 允许差异）', () => {
		const n = normalizeUsage({
			inputTokens: 11583,
			outputTokens: 105,
			totalTokens: 11688,
			inputTokenDetails: { noCacheTokens: 191, cacheReadTokens: 11392, cacheWriteTokens: undefined },
			outputTokenDetails: { textTokens: 105, reasoningTokens: 0 },
		});
		assert.strictEqual(n.usage.totalTokens, 11688, 'total 11688 ≠ 11583+105，仍应保留');
		assert.deepStrictEqual(n.rejected, []);
	});

	it('totalTokens 无效（非有限数）→ 省略并记录拒绝，由调用方按 input+output 回退', () => {
		const n = normalizeUsage({
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: Number.NaN,
			inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: undefined, cacheWriteTokens: undefined },
			outputTokenDetails: { textTokens: 50, reasoningTokens: undefined },
		});
		assert.strictEqual(n.usage.totalTokens, undefined);
		assert.deepStrictEqual(n.rejected, [{ field: 'totalTokens', value: NaN, reason: '非有限非负整数' }]);
	});

	it('input/output 无效（非有限数）→ 按 0 兜底并记录拒绝（含受影响的输入侧细分）', () => {
		const n = normalizeUsage({
			inputTokens: Number.NaN,
			outputTokens: Infinity,
			totalTokens: 150,
			inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: undefined, cacheWriteTokens: undefined },
			outputTokenDetails: { textTokens: 50, reasoningTokens: undefined },
		});
		assert.strictEqual(n.usage.inputTokens, 0);
		assert.strictEqual(n.usage.outputTokens, 0);
		// inputTokens/outputTokens 各 1 条；noCacheTokens=100 超过兜底后的上限 0，也被拒绝
		assert.strictEqual(n.rejected.length, 3);
	});
});
