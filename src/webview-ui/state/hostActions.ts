/**
 * 宿主消息 → reducer 动作映射。
 *
 * 职责：将 Host → Webview 消息（判别联合）转换为 reducer 动作，命令名与字段一一对应。
 * `triggerNewSession` 等需要副作用的命令返回 null，由 App 层在订阅回调中处理。
 */
import type { HostToWebviewMessage } from '../protocol';
import type { ChatAction } from './reducer';

/**
 * 将宿主消息映射为 reducer 动作。
 *
 * @param msg 宿主推送的消息
 * @returns 对应的 reducer 动作；需要副作用的命令返回 null
 */
export function hostToAction(msg: HostToWebviewMessage): ChatAction | null {
	switch (msg.command) {
		case 'runtimeState':
			return { type: 'runtimeState', status: msg.status, message: msg.message };
		case 'modelInfo':
			return { type: 'modelInfo', model: msg.model };
		case 'modelPicker':
			return { type: 'modelPicker', models: msg.models };
		case 'slashCommands':
			return { type: 'slashCommands', groups: msg.groups };
		case 'openSession':
			return { type: 'openSession', sessionId: msg.sessionId, title: msg.title };
		case 'sessionCreated':
			return { type: 'sessionCreated', sessionId: msg.sessionId };
		case 'replyChunk':
			return { type: 'replyChunk', text: msg.text };
		case 'stepEnd':
			return { type: 'stepEnd' };
		case 'tokenUsage':
			return { type: 'tokenUsage', payload: msg.payload };
		case 'sessionTokenUsage':
			return { type: 'sessionTokenUsage', payload: msg.payload };
		case 'replyEnd':
			return { type: 'replyEnd' };
		case 'error':
			return { type: 'error', message: msg.message };
		case 'toolState':
			return {
				type: 'toolState',
				callId: msg.call_id,
				tool: msg.tool,
				state: msg.state,
				error: msg.error,
				args: msg.args,
				output: msg.output,
			};
		case 'diffResult':
			return {
				type: 'diffResult',
				callId: msg.call_id,
				filePath: msg.file_path,
				diffHtml: msg.diff_html,
				additions: msg.additions,
				deletions: msg.deletions,
			};
		case 'toolCall':
			return { type: 'toolCall', callId: msg.call_id, tool: msg.tool, args: msg.args };
		case 'toolResult':
			return { type: 'toolResult', callId: msg.call_id, status: msg.status, result: msg.result, error: msg.error };
		case 'thought':
			return { type: 'thought', text: msg.text };
		case 'progress':
			return { type: 'progress', phase: msg.phase };
		case 'plan':
			return { type: 'plan', steps: msg.steps };
		case 'historyLoaded':
			return { type: 'historyLoaded', messages: msg.messages };
		case 'todoState':
			return { type: 'todoState', snapshot: msg.snapshot, summary: msg.summary };
		case 'approvalRequest':
			return {
				type: 'approvalRequest',
				callId: msg.call_id,
				toolName: msg.tool_name,
				summary: msg.summary,
				filePath: msg.file_path,
			};
		case 'workspaceFiles':
			return { type: 'workspaceFiles', files: msg.files };
		case 'sessionList':
			return { type: 'sessionList', sessions: msg.sessions };
		case 'currentSessionDeleted':
			return { type: 'currentSessionDeleted' };
		case 'rollbackRestored':
			return { type: 'rollbackRestored', text: msg.text };
		case 'triggerNewSession':
			// 需要副作用：由订阅回调发送 createSession
			return null;
		default:
			return null;
	}
}
