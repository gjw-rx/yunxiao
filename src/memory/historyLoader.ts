/**
 * 历史加载器 - 从 MessageStore 加载消息并转换为 LLM 可用格式。
 * 处理 compaction 检查点：从最新 compaction 开始加载，compaction 摘要转为 system 消息。
 * 只消费活动路径投影；归档损坏或工具配对不完整时拒绝构建上下文（不得静默发送不合法序列）。
 */
import type { LLMMessage } from '../llm/types';
import type { Message, AssistantMessage, Attachment } from './types';
import type { MessageStore } from './messageStore';
import * as logger from '../logger';

/**
 * 从 MessageStore 加载历史并转换为 LLMMessage[]。
 * 有 compaction 检查点时从检查点开始，无则加载全部。
 * 归档损坏或工具配对不完整时抛错，阻止不合法上下文进入 LLM 请求。
 * @param sessionId 会话 ID
 * @param store 消息存储
 * @returns LLM 消息数组
 * @throws 归档损坏或工具配对不完整时抛出
 */
export function loadHistoryForLLM(sessionId: string, store: MessageStore): LLMMessage[] {
	const effective = store.getEffectiveHistory(sessionId);
	if (effective.messages.length === 0 && !effective.summary) {
		logger.log(`[HistoryLoader] 加载历史完成 sessionId=${sessionId} 消息数=0`);
		return [];
	}

	// 归档损坏：拒绝使用不完整上下文发起 LLM 请求
	const diagnostics = store.getArchiveDiagnostics(sessionId);
	if (diagnostics.length > 0) {
		logger.error(`[HistoryLoader] 归档损坏，拒绝构建上下文 sessionId=${sessionId} diagnostic=${diagnostics.join('; ')}`);
		throw new Error(`会话归档损坏，拒绝构建 LLM 上下文 sessionId=${sessionId}`);
	}

	// 工具配对完整性：assistant.toolCalls 必须有对应 tool 结果，tool 消息必须有对应调用
	const pairIssue = findToolPairViolations(effective.messages);
	if (pairIssue) {
		logger.error(`[HistoryLoader] 工具配对不完整，拒绝构建上下文 sessionId=${sessionId} issue=${pairIssue}`);
		throw new Error(`会话活动路径工具配对不完整，拒绝构建 LLM 上下文 sessionId=${sessionId}`);
	}

	if (!effective.summary) {
		logger.log(`[HistoryLoader] 加载历史完成 sessionId=${sessionId} 消息数=${effective.messages.length} 压缩点=无`);
		return convertToLLMMessages(effective.messages);
	}

	const result = [
		{ role: 'system' as const, content: effective.summary },
		...(effective.todoContext ? [{ role: 'system' as const, content: effective.todoContext }] : []),
		...convertToLLMMessages(effective.messages),
	];
	logger.log(`[HistoryLoader] 加载历史完成 sessionId=${sessionId} 消息数=${result.length} 压缩点=有 todoContext=${effective.todoContext ? '有' : '无'}`);
	return result;
}

/**
 * 检查消息列表的工具调用配对完整性。
 * @param messages 待检查的消息。
 * @returns 描述违规问题；无违规返回 null。
 */
export function findToolPairViolations(messages: readonly Message[]): string | null {
	const toolResultIds = new Set(messages.filter((m) => m.role === 'tool').map((m) => (m as { toolCallId: string }).toolCallId));
	const declaredIds = new Set<string>();
	for (const message of messages) {
		if (message.role === 'assistant' && message.toolCalls?.length) {
			for (const call of message.toolCalls) {
				declaredIds.add(call.id);
				if (!toolResultIds.has(call.id)) {
					return `assistant 工具调用缺少对应 tool 结果 callId=${call.id}`;
				}
			}
		}
	}
	if (messages.some((m) => m.role === 'tool' && !declaredIds.has((m as { toolCallId: string }).toolCallId))) {
		return `存在孤立 tool 结果（无对应 assistant 工具调用）`;
	}
	return null;
}

/** 将 CompactionMessage 转换为 LLMMessage[]：summary -> system，recentContext 展开。 */
/**
 * 将 Message[] 转换为 LLMMessage[]（剥离 seq，attachments 内联）。
 * 转换前先建立 toolCallId → toolName 映射（来自 assistant.toolCalls），
 * 供缺失 toolName 的旧 tool 结果记录恢复工具名（不修改磁盘上的旧记录）。
 */
function convertToLLMMessages(messages: Message[]): LLMMessage[] {
	const toolNameByCallId = new Map<string, string>();
	for (const message of messages) {
		if (message.role === 'assistant' && message.toolCalls?.length) {
			for (const call of message.toolCalls) {
				toolNameByCallId.set(call.id, call.name);
			}
		}
	}
	return messages.map((msg) => convertMessage(msg, toolNameByCallId));
}

/** 转换单条 Message 为 LLMMessage。 @param toolNameByCallId 从 assistant tool call 收集的 toolCallId → toolName 映射，用于恢复旧 tool 结果记录缺失的工具名。 */
function convertMessage(msg: Message, toolNameByCallId: ReadonlyMap<string, string>): LLMMessage {
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
		case 'tool': {
			const toolName = msg.toolName ?? toolNameByCallId.get(msg.toolCallId);
			return { role: 'tool', toolCallId: msg.toolCallId, content: msg.content, ...(toolName ? { toolName } : {}) };
		}
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
