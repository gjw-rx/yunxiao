/**
 * OpenAI 兼容 Provider - 实现 LLMProvider 接口。
 * 构建 OpenAI /v1/chat/completions 请求，通过原生 fetch 发送，
 * 将响应体交给 streamParser 解析为 LLMEvent 流。
 */
import type { LLMProvider, LLMRequest, LLMEvent, LLMMessage, ToolDefinition } from './types';
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
	readonly stream: true;
}

export class OpenAIProvider implements LLMProvider {
	constructor(private readonly config: ModelConfig) {}

	async *chatCompletion(request: LLMRequest): AsyncGenerator<LLMEvent> {
		const url = `${this.config.baseURL.replace(/\/+$/, '')}/chat/completions`;
		const body: OpenAIRequestBody = {
			model: request.model,
			messages: toOpenAIMessages(request.messages),
			tools: request.tools ? toOpenAITools(request.tools) : undefined,
			tool_choice: request.toolChoice,
			temperature: request.temperature,
			max_tokens: request.maxTokens,
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
