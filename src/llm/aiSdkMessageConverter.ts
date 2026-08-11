/**
 * AI SDK 消息转换器 - 将项目 LLMMessage[] 转换为 AI SDK ModelMessage[]。
 *
 * 覆盖：system / user / assistant(含 toolCalls) / tool 四种消息类型。
 * 转换保持单向：LLMMessage → ModelMessage，不反向。
 *
 * 设计要点：
 * - assistant 的 toolCalls 拆分为 tool-call content parts（input 为已解析对象）
 * - tool 消息的 toolName 在历史中不可得，传空串（OpenAI-compatible 请求只需 tool_call_id + content）
 * - 不引入 AI SDK UI 消息类型，保持存储层独立
 */
import type { LLMMessage } from './types';
import type { ModelMessage } from 'ai';

/**
 * 将项目 LLMMessage[] 转换为 AI SDK ModelMessage[]。
 * @param messages 项目内部的 LLM 消息列表
 * @returns AI SDK streamText 可接受的 ModelMessage[]
 */
export function convertToModelMessages(messages: readonly LLMMessage[]): ModelMessage[] {
	return messages.map(convertMessage);
}

/** 转换单条消息 */
function convertMessage(msg: LLMMessage): ModelMessage {
	switch (msg.role) {
		case 'system':
			return { role: 'system', content: msg.content };
		case 'user':
			return { role: 'user', content: msg.content };
		case 'assistant':
			return convertAssistantMessage(msg);
		case 'tool':
			return convertToolMessage(msg);
	}
}

/**
 * 转换 assistant 消息：有 toolCalls 时拆分为 text + tool-call parts，否则纯文本。
 */
function convertAssistantMessage(msg: { readonly role: 'assistant'; readonly content: string; readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly arguments: string }[] }): ModelMessage {
	if (!msg.toolCalls || msg.toolCalls.length === 0) {
		return { role: 'assistant', content: msg.content };
	}

	// 有 tool calls：content 拆分为 text part + tool-call parts
	const parts: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> = [];
	if (msg.content) {
		parts.push({ type: 'text', text: msg.content });
	}
	for (const tc of msg.toolCalls) {
		parts.push({
			type: 'tool-call',
			toolCallId: tc.id,
			toolName: tc.name,
			input: parseToolCallArguments(tc.arguments),
		});
	}
	return { role: 'assistant', content: parts };
}

/** 转换 tool 消息：toolCallId + content → tool-result part。toolName 不可得时传空串。 */
function convertToolMessage(msg: { readonly role: 'tool'; readonly toolCallId: string; readonly content: string }): ModelMessage {
	return {
		role: 'tool',
		content: [
			{
				type: 'tool-result',
				toolCallId: msg.toolCallId,
				toolName: '', // OpenAI-compatible 请求只需 tool_call_id + content
				output: { type: 'text', value: msg.content },
			},
		],
	};
}

/** 解析 tool call 的 arguments JSON 字符串，失败时返回空对象 */
function parseToolCallArguments(args: string): unknown {
	if (!args) {
		return {};
	}
	try {
		return JSON.parse(args);
	} catch {
		return {};
	}
}
