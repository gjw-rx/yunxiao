/**
 * Anthropic Messages 流式 fixture 集合（Task 1.1）。
 *
 * 用途：为尚不存在的 Anthropic Provider 集成建立离线回归基线——
 * 覆盖文本、reasoning（thinking）、单个与并行工具调用、finish、流内错误、
 * 用户取消、完整 usage（含 cache creation 与大 cache read）。
 *
 * 每个 fixture 是一段符合 Anthropic Messages streaming 协议的原始 SSE 文本
 * （message_start / content_block_start / content_block_delta / content_block_stop /
 * message_delta / message_stop，外加 ping 与 error），可直接喂给 mock fetch，
 * 不依赖真实网络。字段名与 Anthropic 官方 Messages API 一致（如 `cache_read_input_tokens`）。
 */

/** 单条 Anthropic SSE fixture 的元数据 */
export interface AnthropicStreamFixture {
	/** fixture 标识，用于测试名 */
	readonly name: string;
	/** 原始 SSE 文本 */
	readonly sse: string;
	/** HTTP 状态码（默认 200） */
	readonly status?: number;
	/** 期望的文本内容（拼接所有 textDelta） */
	readonly expectedText?: string;
	/** 期望的 reasoning 文本（拼接所有 reasoningDelta） */
	readonly expectedReasoning?: string;
	/** 期望的 toolCall 明细 */
	readonly expectedToolCalls?: ReadonlyArray<{
		readonly id: string;
		readonly name: string;
		readonly arguments: string;
	}>;
	/** 期望的 finish reason（无 finish 时缺省） */
	readonly expectedFinishReason?: 'stop' | 'tool_use' | 'length';
	/** 期望的归一化 usage（无 usage 事件时缺省） */
	readonly expectedUsage?: {
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly noCacheTokens?: number;
		readonly cacheReadTokens?: number;
		readonly cacheWriteTokens?: number;
		readonly reasoningTokens?: number;
		readonly totalTokens?: number;
	};
	/** 是否期望产生 error 事件 */
	readonly expectsError?: boolean;
}

/** message_start 事件（携带初始 usage，input_tokens 为未缓存输入部分） */
function messageStart(opts: { cacheRead?: number; cacheCreation?: number; inputTokens?: number } = {}): string {
	const usage = {
		input_tokens: opts.inputTokens ?? 10,
		cache_read_input_tokens: opts.cacheRead ?? 0,
		cache_creation_input_tokens: opts.cacheCreation ?? 0,
		output_tokens: 0,
	};
	return `event: message_start\ndata: ${JSON.stringify({
		type: 'message_start',
		message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-latest', content: [], usage },
	})}\n\n`;
}

/** text content block（start + 增量 + stop） */
function textBlock(index: number, deltas: readonly string[]): string {
	const parts: string[] = [];
	parts.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}\n\n`);
	for (const d of deltas) {
		parts.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: d } })}\n\n`);
	}
	parts.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
	return parts.join('');
}

/** thinking content block（start + 增量 + stop） */
function thinkingBlock(index: number, deltas: readonly string[]): string {
	const parts: string[] = [];
	parts.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } })}\n\n`);
	for (const d of deltas) {
		parts.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: d } })}\n\n`);
	}
	parts.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
	return parts.join('');
}

/** tool_use content block（start 携带调用 ID/工具名 + input_json_delta 增量 + stop） */
function toolUseBlock(index: number, id: string, name: string, argumentsJson: string): string {
	const parts: string[] = [];
	parts.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`);
	parts.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: argumentsJson } })}\n\n`);
	parts.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
	return parts.join('');
}

/** message_delta 事件（携带最终 stop_reason 与权威 usage） */
function messageDelta(opts: {
	stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
	outputTokens: number;
	inputTokens?: number;
	cacheRead?: number;
	cacheCreation?: number;
	thinkingTokens?: number;
}): string {
	const usage: Record<string, unknown> = {
		output_tokens: opts.outputTokens,
	};
	if (opts.inputTokens !== undefined) { usage.input_tokens = opts.inputTokens; }
	if (opts.cacheRead !== undefined) { usage.cache_read_input_tokens = opts.cacheRead; }
	if (opts.cacheCreation !== undefined) { usage.cache_creation_input_tokens = opts.cacheCreation; }
	if (opts.thinkingTokens !== undefined) { usage.output_tokens_details = { thinking_tokens: opts.thinkingTokens }; }
	return `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: opts.stopReason, stop_sequence: null }, usage })}\n\n`;
}

/** message_stop 事件（流结束标记） */
function messageStop(): string {
	return `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
}

/** 纯文本 fixture：文本 + 完整 usage（无缓存） */
function plainTextFixture(): AnthropicStreamFixture {
	const sse = [
		messageStart({ inputTokens: 12 }),
		textBlock(0, ['hello', ' world']),
		messageDelta({ stopReason: 'end_turn', outputTokens: 5 }),
		messageStop(),
	].join('');
	return {
		name: 'anthropic-plain-text',
		sse,
		expectedText: 'hello world',
		expectedFinishReason: 'stop',
		expectedUsage: { inputTokens: 12, outputTokens: 5, noCacheTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 17 },
	};
}

/** thinking + text 交错 fixture */
function reasoningFixture(): AnthropicStreamFixture {
	const sse = [
		messageStart({ inputTokens: 20 }),
		thinkingBlock(0, ['先分析', '再回答']),
		textBlock(1, ['最终答案']),
		messageDelta({ stopReason: 'end_turn', outputTokens: 30, thinkingTokens: 18 }),
		messageStop(),
	].join('');
	return {
		name: 'anthropic-reasoning-text',
		sse,
		expectedText: '最终答案',
		expectedReasoning: '先分析再回答',
		expectedFinishReason: 'stop',
		expectedUsage: { inputTokens: 20, outputTokens: 30, reasoningTokens: 18, noCacheTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 50 },
	};
}

/** 单个工具调用 fixture */
function singleToolCallFixture(): AnthropicStreamFixture {
	const sse = [
		messageStart({ inputTokens: 15 }),
		toolUseBlock(0, 'toolu_1', 'fs_read_file', '{"path":"/tmp/a.ts"}'),
		messageDelta({ stopReason: 'tool_use', outputTokens: 20 }),
		messageStop(),
	].join('');
	return {
		name: 'anthropic-single-tool-call',
		sse,
		expectedToolCalls: [{ id: 'toolu_1', name: 'fs_read_file', arguments: '{"path":"/tmp/a.ts"}' }],
		expectedFinishReason: 'tool_use',
		expectedUsage: { inputTokens: 15, outputTokens: 20, noCacheTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 35 },
	};
}

/** 并行工具调用 fixture：同名工具两次调用，各自独立调用 ID */
function parallelSameNameToolCallFixture(): AnthropicStreamFixture {
	const sse = [
		messageStart({ inputTokens: 18 }),
		toolUseBlock(0, 'toolu_1', 'git_status', '{}'),
		toolUseBlock(1, 'toolu_2', 'git_status', '{}'),
		messageDelta({ stopReason: 'tool_use', outputTokens: 12 }),
		messageStop(),
	].join('');
	return {
		name: 'anthropic-parallel-same-name-tool-call',
		sse,
		expectedToolCalls: [
			{ id: 'toolu_1', name: 'git_status', arguments: '{}' },
			{ id: 'toolu_2', name: 'git_status', arguments: '{}' },
		],
		expectedFinishReason: 'tool_use',
		expectedUsage: { inputTokens: 18, outputTokens: 12, noCacheTokens: 18, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 30 },
	};
}

/** 完整 usage + 大 cache read fixture（design.md scenario：input=191 cacheRead=11392 cacheCreation=0 output=105 thinking=59） */
function largeCacheReadFixture(): AnthropicStreamFixture {
	const sse = [
		messageStart({ inputTokens: 191, cacheRead: 11392, cacheCreation: 0 }),
		textBlock(0, ['answer']),
		messageDelta({ stopReason: 'end_turn', outputTokens: 105, inputTokens: 191, cacheRead: 11392, cacheCreation: 0, thinkingTokens: 59 }),
		messageStop(),
	].join('');
	return {
		name: 'anthropic-large-cache-read',
		sse,
		expectedText: 'answer',
		expectedFinishReason: 'stop',
		expectedUsage: {
			inputTokens: 11583,
			outputTokens: 105,
			noCacheTokens: 191,
			cacheReadTokens: 11392,
			cacheWriteTokens: 0,
			reasoningTokens: 59,
			totalTokens: 11688,
		},
	};
}

/** cache creation fixture（design.md scenario：input=100 cacheCreation=2000 cacheRead=0 output=50） */
function cacheCreationFixture(): AnthropicStreamFixture {
	const sse = [
		messageStart({ inputTokens: 100, cacheRead: 0, cacheCreation: 2000 }),
		textBlock(0, ['ok']),
		messageDelta({ stopReason: 'end_turn', outputTokens: 50, inputTokens: 100, cacheRead: 0, cacheCreation: 2000 }),
		messageStop(),
	].join('');
	return {
		name: 'anthropic-cache-creation',
		sse,
		expectedText: 'ok',
		expectedFinishReason: 'stop',
		expectedUsage: { inputTokens: 2100, outputTokens: 50, noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 2000, totalTokens: 2150 },
	};
}

/** max_tokens 截断 fixture */
function lengthFinishFixture(): AnthropicStreamFixture {
	const sse = [
		messageStart({ inputTokens: 8 }),
		textBlock(0, ['截断的回复']),
		messageDelta({ stopReason: 'max_tokens', outputTokens: 4096 }),
		messageStop(),
	].join('');
	return {
		name: 'anthropic-length-finish',
		sse,
		expectedText: '截断的回复',
		expectedFinishReason: 'length',
		expectedUsage: { inputTokens: 8, outputTokens: 4096, noCacheTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 4104 },
	};
}

/** 流内错误 fixture：message_start 之后收到 error 事件 */
function streamErrorFixture(): AnthropicStreamFixture {
	const sse = [
		messageStart({ inputTokens: 5 }),
		textBlock(0, ['开始']),
		`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`,
	].join('');
	return {
		name: 'anthropic-stream-error',
		sse,
		expectedText: '开始',
		expectsError: true,
	};
}

/** 用户取消 fixture：流持续输出，消费端在首段后中断（与 legacy cancel fixture 语义一致） */
function cancelledStreamFixture(): AnthropicStreamFixture {
	const sse = [
		messageStart({ inputTokens: 5 }),
		textBlock(0, ['partial', ' response', ' should not appear']),
		messageDelta({ stopReason: 'end_turn', outputTokens: 10 }),
		messageStop(),
	].join('');
	return {
		name: 'anthropic-cancelled-stream',
		sse,
		expectedText: 'partial response',
	};
}

/** 鉴权失败 fixture：HTTP 401，非 SSE JSON 错误体 */
function authErrorFixture(): AnthropicStreamFixture {
	return {
		name: 'anthropic-auth-error',
		sse: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
		status: 401,
		expectsError: true,
	};
}

/** 所有 fixture 的有序集合 */
export const ANTHROPIC_STREAM_FIXTURES: readonly AnthropicStreamFixture[] = [
	plainTextFixture(),
	reasoningFixture(),
	singleToolCallFixture(),
	parallelSameNameToolCallFixture(),
	largeCacheReadFixture(),
	cacheCreationFixture(),
	lengthFinishFixture(),
	streamErrorFixture(),
	cancelledStreamFixture(),
	authErrorFixture(),
];

/** 按名查找 fixture */
export function getAnthropicFixture(name: string): AnthropicStreamFixture {
	const f = ANTHROPIC_STREAM_FIXTURES.find((x) => x.name === name);
	if (!f) {
		throw new Error(`fixture not found: ${name}`);
	}
	return f;
}
