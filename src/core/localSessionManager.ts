/**
 * LocalSessionManager - 本地会话管理器。
 *
 * 薄包装层：管理 sessionId 映射，将消息发送委托给 AgentLoop，
 * 历史加载委托给 MessageStore。替代旧的云端 SessionManager。
 */
import { randomUUID } from 'crypto';
import type { AgentLoop } from '../agent/agentLoop';
import type { MessageStore } from '../memory/messageStore';
import type { Message } from '../memory/types';
import * as logger from '../logger';

/** 前端期望的历史消息格式。 */
export interface HistoryEntry {
	role: string;
	content: string;
	toolCalls?: Array<{ id: string; name: string; arguments: string }>;
	toolCallId?: string;
}

export class LocalSessionManager {
	private currentSessionId: string | undefined;

	constructor(
		private readonly agentLoop: AgentLoop,
		private readonly messageStore: MessageStore,
	) {}

	/** 创建新会话，返回会话 ID。 */
	createSession(): string {
		const sessionId = randomUUID();
		this.currentSessionId = sessionId;
		logger.log(`[SessionManager] 创建会话 sessionId=${sessionId}`);
		return sessionId;
	}

	/** 发送用户消息，委托给 AgentLoop.run()。 */
	sendMessage(sessionId: string, text: string): void {
		this.currentSessionId = sessionId;
		logger.log(`[SessionManager] 发送消息 sessionId=${sessionId} 文本长度=${text.length}`);
		void this.agentLoop.run(sessionId, text).catch((err) => {
			logger.notifyError('[SessionManager] AgentLoop.run 异常', err instanceof Error ? err.message : String(err));
		});
	}

	/** 取消当前会话的 Agent Loop。 */
	cancel(sessionId: string): void {
		logger.log(`[SessionManager] 取消会话 sessionId=${sessionId}`);
		this.agentLoop.cancel();
	}

	/** 加载会话历史，从 MessageStore 读取并转换为前端格式。 */
	loadHistory(sessionId: string): HistoryEntry[] {
		const messages = this.messageStore.loadHistory(sessionId);
		return messages
			.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
			.map((m) => {
				if (m.role === 'assistant' && 'toolCalls' in m && m.toolCalls) {
					return { role: m.role, content: m.content, toolCalls: m.toolCalls };
				}
				if (m.role === 'tool' && 'toolCallId' in m) {
					return { role: m.role, content: m.content, toolCallId: (m as { toolCallId: string }).toolCallId };
				}
				return { role: m.role, content: m.content };
			});
	}

	/** 重置会话：取消 AgentLoop + 清空 MessageStore。 */
	reset(sessionId: string): void {
		this.agentLoop.cancel();
		this.messageStore.clear(sessionId);
	}

	/** 获取当前会话 ID。 */
	getCurrentSessionId(): string | undefined {
		return this.currentSessionId;
	}

	/** 设置当前会话 ID（用于历史会话切换）。 */
	setCurrentSessionId(sessionId: string): void {
		this.currentSessionId = sessionId;
	}
}
