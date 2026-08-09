/**
 * SSE 流式解析器 - 解析 OpenAI 兼容的流式响应。
 * 从 ReadableStream 中逐行提取 `data:` 行，解析 JSON chunk，
 * 合并 tool_calls 增量片段，以 LLMEvent 序列 yield。
 */
import type { LLMEvent } from './types';
import * as logger from '../logger';

/** OpenAI SSE chunk 中的 delta.tool_calls 片段 */
interface ToolCallDelta {
	readonly index: number;
	readonly id?: string;
	readonly function?: {
		readonly name?: string;
		readonly arguments?: string;
	};
}

/** OpenAI SSE chunk 结构（仅关注需要的字段） */
interface SSEChunk {
	readonly choices?: ReadonlyArray<{
		readonly delta?: {
			readonly content?: string;
			/** DeepSeek 思维链增量 */
			readonly reasoning_content?: string;
			/** OpenAI reasoning 规范下的思维链增量 */
			readonly reasoning?: string;
			readonly tool_calls?: readonly ToolCallDelta[];
		};
		readonly finish_reason?: string | null;
	}>;
	readonly usage?: {
		readonly prompt_tokens?: number;
		readonly completion_tokens?: number;
		readonly total_tokens?: number;
		readonly reasoning_tokens?: number;
	};
}

/** tool_call 增量累加器 */
interface ToolCallAccumulator {
	id: string;
	name: string;
	arguments: string;
}

/**
 * 解析 OpenAI 兼容的 SSE 流，yield LLMEvent。
 *
 * 处理逻辑：
 * 1. 按 `\n` 分割缓冲区，提取 `data: ` 前缀行
 * 2. 跳过空行和 `[DONE]` 标记
 * 3. 解析 JSON chunk
 * 4. delta.content -> textDelta 事件
 * 5. delta.reasoning_content / delta.reasoning -> reasoningDelta 事件（思维链）
 * 6. delta.tool_calls 按 index 合并，完成时 yield toolCall 事件
 * 7. finish_reason -> finish 事件
 * 8. usage -> usage 事件
 */
export async function* parseSSEStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<LLMEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8');
	let buffer = '';
	const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			// 保留最后一行（可能不完整）
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || !trimmed.startsWith('data:')) {
					continue;
				}

				const data = trimmed.slice(5).trim();
				if (data === '[DONE]') {
					continue;
				}

				let chunk: SSEChunk;
				try {
					chunk = JSON.parse(data) as SSEChunk;
				} catch {
					logger.error('[StreamParser] JSON 解析失败', data.slice(0, 200));
					// 跳过无法解析的行
					continue;
				}

				const choice = chunk.choices?.[0];
				if (!choice) {
					// 可能是只含 usage 的 chunk
					if (chunk.usage) {
						yield {
							type: 'usage',
							inputTokens: chunk.usage.prompt_tokens ?? 0,
							outputTokens: chunk.usage.completion_tokens ?? 0,
							reasoningTokens: chunk.usage.reasoning_tokens,
							totalTokens: chunk.usage.total_tokens,
						};
					}
					continue;
				}

				// 处理文本增量
				if (choice.delta?.content) {
					yield { type: 'textDelta', text: choice.delta.content };
				}

				// 处理思维链增量（DeepSeek: reasoning_content；OpenAI: reasoning）
				if (choice.delta?.reasoning_content) {
					yield { type: 'reasoningDelta', text: choice.delta.reasoning_content };
				}
				if (choice.delta?.reasoning) {
					yield { type: 'reasoningDelta', text: choice.delta.reasoning };
				}

				// 处理 tool_calls 增量
				if (choice.delta?.tool_calls) {
					for (const tc of choice.delta.tool_calls) {
						const existing = toolCallAccumulators.get(tc.index);
						const id = tc.id ?? existing?.id ?? '';
						const name = (existing?.name ?? '') + (tc.function?.name ?? '');
						const args = (existing?.arguments ?? '') + (tc.function?.arguments ?? '');

						toolCallAccumulators.set(tc.index, { id, name, arguments: args });
					}
				}

				// 处理 finish_reason
				if (choice.finish_reason) {
					// finish_reason 出现时，flush 所有已积累的 tool_calls
					if (toolCallAccumulators.size > 0) {
						const sortedIndices = [...toolCallAccumulators.keys()].sort((a, b) => a - b);
						for (const idx of sortedIndices) {
							const acc = toolCallAccumulators.get(idx)!;
							yield {
								type: 'toolCall',
								id: acc.id,
								name: acc.name,
								arguments: acc.arguments,
							};
						}
						toolCallAccumulators.clear();
					}

					const reason = mapFinishReason(choice.finish_reason);
					yield { type: 'finish', reason };
				}

				// 处理 usage（有些 Provider 在最后一个 chunk 附带 usage）
				if (chunk.usage) {
					yield {
						type: 'usage',
						inputTokens: chunk.usage.prompt_tokens ?? 0,
						outputTokens: chunk.usage.completion_tokens ?? 0,
						reasoningTokens: chunk.usage.reasoning_tokens,
						totalTokens: chunk.usage.total_tokens,
					};
				}
			}
		}

		// flush 剩余缓冲中的完整行
		const remaining = buffer.trim();
		if (remaining.startsWith('data:')) {
			const data = remaining.slice(5).trim();
			if (data && data !== '[DONE]') {
				try {
					const chunk = JSON.parse(data) as SSEChunk;
					const choice = chunk.choices?.[0];
					if (choice?.finish_reason) {
						if (toolCallAccumulators.size > 0) {
							const sortedIndices = [...toolCallAccumulators.keys()].sort((a, b) => a - b);
							for (const idx of sortedIndices) {
								const acc = toolCallAccumulators.get(idx)!;
								yield {
									type: 'toolCall',
									id: acc.id,
									name: acc.name,
									arguments: acc.arguments,
								};
							}
						}
						yield { type: 'finish', reason: mapFinishReason(choice.finish_reason) };
					}
				} catch {
					// 忽略解析错误
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/** 将 OpenAI finish_reason 映射到 LLMEvent 的 reason */
function mapFinishReason(reason: string): 'stop' | 'tool_use' | 'length' {
	switch (reason) {
		case 'stop':
			return 'stop';
		case 'tool_calls':
			return 'tool_use';
		case 'length':
			return 'length';
		default:
			return 'stop';
	}
}

/** 供测试导出的类型 */
export type { SSEChunk, ToolCallDelta, ToolCallAccumulator };
