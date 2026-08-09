/**
 * OpenAI 兼容 Provider - 实现 LLMProvider 接口。
 * 构建 OpenAI /v1/chat/completions 请求，通过原生 fetch 发送，
 * 将响应体交给 streamParser 解析为 LLMEvent 流。
 */
import type { LLMProvider, LLMRequest, LLMEvent, LLMMessage, ToolDefinition, ReasoningEffort } from './types';
import type { ModelConfig } from '../config/modelConfig';
import { parseSSEStream } from './streamParser';
import * as logger from '../logger';

/** OpenAI message 格式 */
interface OpenAIMessage {
	readonly role: string;
	readonly content?: string;
	readonly tool_calls?: readonly OpenAIToolCall[];
	readonly tool_call_id?: string;
}

/** OpenAI tool_call 格式 */
interface OpenAIToolCall {
	readonly id: string;
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly arguments: string;
	};
}

/** OpenAI function 定义 */
interface OpenAITool {
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters: Record<string, unknown>;
	};
}

/** OpenAI 请求体 */
interface OpenAIRequestBody {
	readonly model: string;
	readonly messages: readonly OpenAIMessage[];
	readonly tools?: readonly OpenAITool[];
	readonly tool_choice?: string;
	readonly temperature?: number;
	readonly max_tokens?: number;
	/** OpenAI reasoning 规范：思维链强度 */
	readonly reasoning_effort?: string;
	/** DeepSeek 思考开关（V3.2+ / V4） */
	readonly thinking?: { readonly type: 'enabled' | 'disabled' };
	readonly stream: true;
}

export class OpenAIProvider implements LLMProvider {
	constructor(private readonly config: ModelConfig) {}

	async *chatCompletion(request: LLMRequest): AsyncGenerator<LLMEvent> {
		const url = `${this.config.baseURL.replace(/\/+$/, '')}/chat/completions`;
		const reasoningParams = buildReasoningParams(request.reasoningEffort, this.config.provider, this.config.baseURL);
		// DeepSeek 开启思考时 temperature 仅支持 1.0：省略该字段（JSON.stringify 丢弃 undefined）
		const deepseekThinking = reasoningParams.thinking?.type === 'enabled';
		const body: OpenAIRequestBody = {
			model: request.model,
			messages: toOpenAIMessages(request.messages),
			tools: request.tools ? toOpenAITools(request.tools) : undefined,
			tool_choice: request.toolChoice,
			temperature: deepseekThinking ? undefined : request.temperature,
			max_tokens: request.maxTokens,
			...reasoningParams,
			stream: true,
		};

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.config.apiKey}`,
				},
				body: JSON.stringify(body),
			});
		} catch (err) {
			logger.notifyError('[LLM] 网络请求失败', { url, error: err instanceof Error ? err.message : String(err) });
			yield {
				type: 'error',
				error: `网络请求失败: ${err instanceof Error ? err.message : String(err)}`,
			};
			return;
		}

		if (!response.ok || !response.body) {
			const errorText = await response.text().catch(() => '');
			logger.notifyError('[LLM] API 返回错误', { status: response.status, url, errorText: errorText.slice(0, 300) });
			yield {
				type: 'error',
				error: `LLM 返回错误 ${response.status}: ${errorText.slice(0, 500)}`,
			};
			return;
		}

		yield* parseSSEStream(response.body);
	}
}

/** 将 LLMMessage[] 转换为 OpenAI message 格式 */
function toOpenAIMessages(messages: readonly LLMMessage[]): OpenAIMessage[] {
	return messages.map((msg) => {
		switch (msg.role) {
			case 'system':
				return { role: 'system', content: msg.content };
			case 'user':
				return { role: 'user', content: msg.content };
			case 'assistant':
				return {
					role: 'assistant',
					content: msg.content,
					tool_calls: msg.toolCalls?.map(toOpenAIToolCall),
				};
			case 'tool':
				return {
					role: 'tool',
					content: msg.content,
					tool_call_id: msg.toolCallId,
				};
		}
	});
}

/** 将 LLMToolCall 转换为 OpenAI tool_call 格式 */
function toOpenAIToolCall(tc: { id: string; name: string; arguments: string }): OpenAIToolCall {
	return {
		id: tc.id,
		type: 'function',
		function: { name: tc.name, arguments: tc.arguments },
	};
}

/** 将 ToolDefinition[] 转换为 OpenAI function 格式 */
function toOpenAITools(tools: readonly ToolDefinition[]): OpenAITool[] {
	return tools.map((t) => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));
}

/**
 * 按 OpenAI reasoning 规范构造思维链请求参数（优先 DeepSeek 协议）。
 * - DeepSeek（provider 或 baseURL 命中 deepseek）: 默认开启思考（thinking.type='enabled'），
 *   显式档位时附 reasoning_effort；'disabled' 时发 thinking.type='disabled'。
 * - 其他 OpenAI-compatible 后端: 仅显式档位时传 reasoning_effort（非推理模型传参可能 400，
 *   故默认不传）；OpenAI 无 disabled 档位，'disabled' 等同不传。
 * - 未设置: DeepSeek 默认开启思考；其余交给后端默认。
 */
function buildReasoningParams(
	effort: ReasoningEffort | undefined,
	providerId: string,
	baseURL: string,
): Pick<OpenAIRequestBody, 'reasoning_effort' | 'thinking'> {
	const isDeepSeek =
		providerId.toLowerCase().includes('deepseek') || baseURL.toLowerCase().includes('deepseek.com');
	if (isDeepSeek) {
		if (effort === undefined) {
			return { thinking: { type: 'enabled' } };
		}
		return effort === 'disabled'
			? { thinking: { type: 'disabled' } }
			// DeepSeek 无 minimal 档，映射为最弱档 low
			: { thinking: { type: 'enabled' }, reasoning_effort: effort === 'minimal' ? 'low' : effort };
	}

	return effort && effort !== 'disabled' ? { reasoning_effort: effort } : {};
}
