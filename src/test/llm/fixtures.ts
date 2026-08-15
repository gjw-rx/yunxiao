/**
 * LLM 流式 fixture 集合 - 记录 OpenAI-compatible 端点的代表性 SSE 响应。
 *
 * 用途：
 * 1. 为现有 parseSSEStream 建立回归测试基线（streamParser.regression.test.ts）。
 * 2. 作为 legacy runtime 与 AI SDK runtime 适配器的事件序列差异比对输入（runtimeParity.test.ts）。
 *
 * 每个 fixture 是一段完整 SSE 文本，按 OpenAI Chat Completions streaming 协议组织。
 * 不依赖网络：直接构造可解析的 SSE 字符串，覆盖文本/reasoning/tool call/usage/finish/错误/取消路径。
 */

/** 单条 fixture 的元数据与原始 SSE 文本 */
export interface StreamFixture {
	/** fixture 标识，用于测试名 */
	readonly name: string;
	/** 原始 SSE 文本（可直接喂给 parseSSEStream） */
	readonly sse: string;
	/** 期望产生的事件类型序列（按出现顺序，便于断言） */
	readonly expectedEventTypes: readonly string[];
	/** 期望的 finish 事件 reason（无 finish 时为 undefined） */
	readonly expectedFinishReason?: 'stop' | 'tool_use' | 'length';
	/** 期望的 usage 字段（无 usage 事件时为 undefined） */
	readonly expectedUsage?: {
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly reasoningTokens?: number;
		readonly totalTokens?: number;
	};
	/** 期望的文本内容（拼接所有 textDelta） */
	readonly expectedText?: string;
	/** 期望的 reasoning 文本（拼接所有 reasoningDelta） */
	readonly expectedReasoning?: string;
	/** 期望的 toolCall 数量 */
	readonly expectedToolCallCount?: number;
	/** 期望的 toolCall 明细（id/name/arguments JSON 字符串），供 parity 测试构造 AI SDK parts */
	readonly expectedToolCalls?: ReadonlyArray<{
		readonly id: string;
		readonly name: string;
		readonly arguments: string;
	}>;
}

/** 拼接多段文本增量的 SSE 流，最后附 finish 与 usage */
function textStreamFixture(
	name: string,
	deltas: readonly string[],
	opts: { finish?: 'stop' | 'length'; usage?: { prompt: number; completion: number; reasoning?: number; total?: number } } = {},
): StreamFixture {
	const sseParts: string[] = [];
	for (const d of deltas) {
		sseParts.push(`data: {"choices":[{"delta":{"content":${JSON.stringify(d)}}}]}\n\n`);
	}
	const finish = opts.finish ?? 'stop';
	sseParts.push(`data: {"choices":[{"finish_reason":${JSON.stringify(finish)}}]}\n\n`);
	if (opts.usage) {
		const u: Record<string, number> = { prompt_tokens: opts.usage.prompt, completion_tokens: opts.usage.completion };
		if (opts.usage.reasoning !== undefined) {
			u.reasoning_tokens = opts.usage.reasoning;
		}
		if (opts.usage.total !== undefined) {
			u.total_tokens = opts.usage.total;
		}
		sseParts.push(`data: {"usage":${JSON.stringify(u)}}\n\n`);
	}
	sseParts.push('data: [DONE]\n\n');

	const expectedEventTypes: string[] = deltas.map(() => 'textDelta');
	expectedEventTypes.push('finish');
	if (opts.usage) {
		expectedEventTypes.push('usage');
	}

	return {
		name,
		sse: sseParts.join(''),
		expectedEventTypes,
		expectedFinishReason: finish,
		expectedUsage: opts.usage
			? {
				inputTokens: opts.usage.prompt,
				outputTokens: opts.usage.completion,
				...(opts.usage.reasoning !== undefined ? { reasoningTokens: opts.usage.reasoning } : {}),
				...(opts.usage.total !== undefined ? { totalTokens: opts.usage.total } : {}),
			}
			: undefined,
		expectedText: deltas.join(''),
	};
}

/** DeepSeek 风格 reasoning_content + 正文 + finish + usage 流 */
function deepSeekReasoningFixture(): StreamFixture {
	const sse =
		'data: {"choices":[{"delta":{"reasoning_content":"先"}}]}\n\n' +
		'data: {"choices":[{"delta":{"reasoning_content":"分析问题"}}]}\n\n' +
		'data: {"choices":[{"delta":{"content":"答案是"}}]}\n\n' +
		'data: {"choices":[{"delta":{"content":"42"}}]}\n\n' +
		'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":40,"total_tokens":160,"reasoning_tokens":15}}\n\n' +
		'data: [DONE]\n\n';
	return {
		name: 'deepseek-reasoning-with-usage',
		sse,
		expectedEventTypes: ['reasoningDelta', 'reasoningDelta', 'textDelta', 'textDelta', 'finish', 'usage'],
		expectedFinishReason: 'stop',
		expectedUsage: { inputTokens: 120, outputTokens: 40, reasoningTokens: 15, totalTokens: 160 },
		expectedText: '答案是42',
		expectedReasoning: '先分析问题',
	};
}

/** OpenAI reasoning 规范（delta.reasoning 字段）流 */
function openaiReasoningFixture(): StreamFixture {
	const sse =
		'data: {"choices":[{"delta":{"reasoning":"Let me"}}]}\n\n' +
		'data: {"choices":[{"delta":{"reasoning":" think"}}]}\n\n' +
		'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
		'data: {"choices":[{"finish_reason":"stop"}]}\n\n' +
		'data: [DONE]\n\n';
	return {
		name: 'openai-reasoning-no-usage',
		sse,
		expectedEventTypes: ['reasoningDelta', 'reasoningDelta', 'textDelta', 'finish'],
		expectedFinishReason: 'stop',
		expectedText: 'ok',
		expectedReasoning: 'Let me think',
	};
}

/** 单个 tool call 的完整流：增量 name 与 arguments 片段合并后产生 toolCall + finish */
function singleToolCallFixture(): StreamFixture {
	const sse =
		'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"fs_read_"}}]}}]}\n\n' +
		'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"{\\"path\\":"}}]}}]}\n\n' +
		'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \\"/tmp/a.ts\\"}"}}]}}]}\n\n' +
		'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n' +
		'data: [DONE]\n\n';
	return {
		name: 'single-tool-call',
		sse,
		expectedEventTypes: ['toolCall', 'finish'],
		expectedFinishReason: 'tool_use',
		expectedToolCallCount: 1,
		expectedToolCalls: [
			{ id: 'call_1', name: 'fs_read_file', arguments: '{"path": "/tmp/a.ts"}' },
		],
	};
}

/** 多个 tool call 在同一轮中产生的流 */
function multiToolCallFixture(): StreamFixture {
	const sse =
		'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"fs_read_file","arguments":"{\\"path\\":\\"/a\\"}"}}]}}]}\n\n' +
		'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"fs_list_dir","arguments":"{\\"path\\":\\"/b\\"}"}}]}}]}\n\n' +
		'data: {"choices":[{"delta":{"tool_calls":[{"index":2,"id":"call_3","function":{"name":"git_status","arguments":"{}"}}]}}]}\n\n' +
		'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n' +
		'data: [DONE]\n\n';
	return {
		name: 'multi-tool-call',
		sse,
		expectedEventTypes: ['toolCall', 'toolCall', 'toolCall', 'finish'],
		expectedFinishReason: 'tool_use',
		expectedToolCallCount: 3,
		expectedToolCalls: [
			{ id: 'call_1', name: 'fs_read_file', arguments: '{"path":"/a"}' },
			{ id: 'call_2', name: 'fs_list_dir', arguments: '{"path":"/b"}' },
			{ id: 'call_3', name: 'git_status', arguments: '{}' },
		],
	};
}

/** usage 单独 chunk 流（部分 provider 把 usage 放在最终独立 chunk） */
function usageOnlyChunkFixture(): StreamFixture {
	const sse =
		'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
		'data: {"choices":[{"finish_reason":"stop"}]}\n\n' +
		'data: {"usage":{"prompt_tokens":50,"completion_tokens":10,"total_tokens":60}}\n\n' +
		'data: [DONE]\n\n';
	return {
		name: 'usage-only-chunk',
		sse,
		expectedEventTypes: ['textDelta', 'finish', 'usage'],
		expectedFinishReason: 'stop',
		expectedUsage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
		expectedText: 'hi',
	};
}

/** finish_reason=length 截断流 */
function lengthFinishFixture(): StreamFixture {
	const sse =
		'data: {"choices":[{"delta":{"content":"partial answer..."}}]}\n\n' +
		'data: {"choices":[{"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":4096,"total_tokens":4106}}\n\n' +
		'data: [DONE]\n\n';
	return {
		name: 'length-finish',
		sse,
		expectedEventTypes: ['textDelta', 'finish', 'usage'],
		expectedFinishReason: 'length',
		expectedUsage: { inputTokens: 10, outputTokens: 4096, totalTokens: 4106 },
		expectedText: 'partial answer...',
	};
}

/**
 * 用户取消 fixture：流在文本增量之后被中断（无 finish、无 usage）。
 * parseSSEStream 在流自然结束时不会补发 finish，故 expectedEventTypes 不含 finish。
 * 该 fixture 模拟 abort：只产生部分 textDelta 后流被关闭。
 */
function cancelledStreamFixture(): StreamFixture {
	const sse =
		'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' +
		'data: {"choices":[{"delta":{"content":" response"}}]}\n\n';
	return {
		name: 'cancelled-stream',
		sse,
		expectedEventTypes: ['textDelta', 'textDelta'],
		expectedText: 'partial response',
	};
}

/** 空流（只有 [DONE]） */
function emptyStreamFixture(): StreamFixture {
	return {
		name: 'empty-stream',
		sse: 'data: [DONE]\n\n',
		expectedEventTypes: [],
	};
}

/** 所有 fixture 的有序集合 */
export const STREAM_FIXTURES: readonly StreamFixture[] = [
	textStreamFixture('plain-text-stop', ['hello', ' world'], { usage: { prompt: 5, completion: 2, total: 7 } }),
	deepSeekReasoningFixture(),
	openaiReasoningFixture(),
	singleToolCallFixture(),
	multiToolCallFixture(),
	usageOnlyChunkFixture(),
	lengthFinishFixture(),
	cancelledStreamFixture(),
	emptyStreamFixture(),
];

/** 按名查找 fixture */
export function getFixture(name: string): StreamFixture {
	const f = STREAM_FIXTURES.find((x) => x.name === name);
	if (!f) {
		throw new Error(`fixture not found: ${name}`);
	}
	return f;
}
