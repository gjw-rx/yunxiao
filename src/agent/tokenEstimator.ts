/**
 * Token 估算器 - 基于字符数/4 近似估算消息 token 消耗。
 * 不引入外部依赖，适用于压缩触发判断和预算估算。
 */
import type { Message } from '../memory/types';

/** 估算单条消息的 token 数。 */
export function estimateMessage(msg: Message): number {
	const text = getMessageText(msg);
	return Math.ceil(text.length / 4);
}

/** 估算消息数组的 token 总数。 */
export function estimateMessages(messages: Message[]): number {
	let total = 0;
	for (const msg of messages) {
		total += estimateMessage(msg);
	}
	return total;
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