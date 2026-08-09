/**
 * Token 估算器 - 基于字符数/4 近似估算消息 token 消耗。
 * 不引入外部依赖，适用于压缩触发判断和预算估算。
 */
import type { Message } from '../memory/types';
import type { LLMMessage, ToolDefinition } from '../llm/types';

/** 估算任意字符串的 token 数（字符数/4）。 */
export function estimateText(text: string): number {
	return Math.ceil(text.length / 4);
}

/** 估算单条消息的 token 数。 */
export function estimateMessage(msg: Message): number {
	const text = getMessageText(msg);
	return estimateText(text);
}

/** 估算消息数组的 token 总数。 */
export function estimateMessages(messages: Message[]): number {
	let total = 0;
	for (const msg of messages) {
		total += estimateMessage(msg);
	}
	return total;
}

/**
 * 估算完整 LLM 请求体的 token 数（system prompt + 消息 + 工具定义），
 * 用于 usage 缺失时的 input_length 兜底。
 */
export function estimateRequest(
	systemPrompt: string,
	messages: LLMMessage[],
	tools?: ToolDefinition[],
): number {
	let total = estimateText(systemPrompt);
	for (const msg of messages) {
		total += estimateText(getLLMMessageText(msg));
	}
	if (tools) {
		for (const tool of tools) {
			total += estimateText(tool.name + tool.description + JSON.stringify(tool.parameters));
		}
	}
	return total;
}

/** 提取 LLM 消息的文本内容用于 token 估算。 */
function getLLMMessageText(msg: LLMMessage): string {
	switch (msg.role) {
		case 'system':
			return msg.content;
		case 'user':
			return msg.content;
		case 'assistant':
			return msg.content + (msg.toolCalls ? msg.toolCalls.map((tc) => tc.name + tc.arguments).join('') : '');
		case 'tool':
			return msg.content;
	}
}

/** 提取消息的文本内容用于 token 估算。 */
function getMessageText(msg: Message): string {
	switch (msg.role) {
		case 'system':
			return msg.content;
		case 'user':
			return msg.content + (msg.attachments ? msg.attachments.map((a) => a.content).join('') : '');
		case 'assistant':
			return msg.content + (msg.toolCalls ? msg.toolCalls.map((tc) => tc.name + tc.arguments).join('') : '');
		case 'tool':
			return msg.content;
		case 'compaction':
			return msg.summary + msg.recentContext.map((m) => getMessageText(m)).join('');
	}
}