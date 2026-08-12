/**
 * 历史加载器 - 从 MessageStore 加载消息并转换为 LLM 可用格式。
 * 处理 compaction 检查点：从最新 compaction 开始加载，compaction 摘要转为 system 消息。
 */
import type { LLMMessage } from '../llm/types';
import type { Message, Attachment } from './types';
import type { MessageStore } from './messageStore';
import * as logger from '../logger';

/**
 * 从 MessageStore 加载历史并转换为 LLMMessage[]。
 * 有 compaction 检查点时从检查点开始，无则加载全部。
 */
export function loadHistoryForLLM(sessionId: string, store: MessageStore): LLMMessage[] {
	const effective = store.getEffectiveHistory(sessionId);
	if (effective.messages.length === 0 && !effective.summary) {
		logger.log(`[HistoryLoader] 加载历史完成 sessionId=${sessionId} 消息数=0`);
		return [];
	}

	if (!effective.summary) {
		logger.log(`[HistoryLoader] 加载历史完成 sessionId=${sessionId} 消息数=${effective.messages.length} 压缩点=无`);
		return convertToLLMMessages(effective.messages);
	}

	const result = [
		{ role: 'system' as const, content: effective.summary },
		...convertToLLMMessages(effective.messages),
	];
	logger.log(`[HistoryLoader] 加载历史完成 sessionId=${sessionId} 消息数=${result.length} 压缩点=有`);
	return result;
}

/** 将 CompactionMessage 转换为 LLMMessage[]：summary -> system，recentContext 展开。 */
/** 将 Message[] 转换为 LLMMessage[]（剥离 seq，attachments 内联）。 */
function convertToLLMMessages(messages: Message[]): LLMMessage[] {
	return messages.map(convertMessage);
}

/** 转换单条 Message 为 LLMMessage。 */
function convertMessage(msg: Message): LLMMessage {
	switch (msg.role) {
		case 'system':
			return { role: 'system', content: msg.content };
		case 'user':
			return { role: 'user', content: inlineAttachments(msg.content, msg.attachments) };
		case 'assistant':
			return {
				role: 'assistant',
				content: msg.content,
				...(msg.toolCalls ? { toolCalls: msg.toolCalls } : {}),
			};
		case 'tool':
			return { role: 'tool', toolCallId: msg.toolCallId, content: msg.content };
		case 'compaction':
			// compaction 在 convertCompaction 中处理，此处不应到达
			return { role: 'system', content: msg.summary };
	}
}

/** 将附件内容内联到消息文本中。 */
function inlineAttachments(content: string, attachments?: readonly Attachment[]): string {
	if (!attachments || attachments.length === 0) {
		return content;
	}
	const parts = [content];
	for (const att of attachments) {
		parts.push(`\n--- Attachment: ${att.path} ---\n${att.content}`);
	}
	return parts.join('');
}
