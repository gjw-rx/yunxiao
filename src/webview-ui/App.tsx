/**
 * Webview 根应用组件。
 *
 * 职责：持有全局 reducer 状态，订阅宿主消息（Host → Webview）并转换为 reducer 动作；
 * 应用挂载完成后发送 `webviewReady` 握手并请求初始数据；组装会话头部、
 * Token 条、消息流、错误条与消息输入等全部界面组件，并处理发送等副作用。
 */
import { useEffect, useReducer, useRef, type JSX } from 'react';
import { chatReducer, initialState } from './state/reducer';
import { hostToAction } from './state/hostActions';
import { post, subscribe } from './bridge/vscode';
import type { HostToWebviewMessage, SlashCommand, WorkspaceFile } from './protocol';
import { SessionHeader } from './components/session/SessionHeader';
import { SessionTokenBar } from './components/session/SessionTokenBar';
import { MessageList } from './components/chat/MessageList';
import { MessageInput } from './components/chat/MessageInput';
import { ErrorBar } from './components/shared/ErrorBar';
import { SettingsPage } from './components/settings/SettingsPage';

/** Webview 根应用。 */
export function App(): JSX.Element {
	const [state, dispatch] = useReducer(chatReducer, initialState);
	const isSettingsView = document.body.dataset.view === 'settings';
	const dispatchRef = useRef(dispatch);
	const initialDataRequestedRef = useRef(false);
	dispatchRef.current = dispatch;

	useEffect(() => {
		if (isSettingsView) {
			return;
		}
		const dispose = subscribe((msg: HostToWebviewMessage) => {
			const action = hostToAction(msg);
			if (action) {
				dispatchRef.current(action);
			}
			if (msg.command === 'runtimeState' && msg.status === 'ready' && !initialDataRequestedRef.current) {
				initialDataRequestedRef.current = true;
				post({ command: 'requestSlashCommands' });
				post({ command: 'createSession' });
			}
			// 副作用：会话打开/创建后请求历史
			if (msg.command === 'openSession' || msg.command === 'sessionCreated') {
				post({ command: 'loadHistory', sessionId: msg.sessionId });
			}
			if (msg.command === 'triggerNewSession' && initialDataRequestedRef.current) {
				post({ command: 'createSession' });
			}
		});
		// 先订阅再握手，确保宿主同步推送的运行时状态不会丢失。
		post({ command: 'webviewReady' });

		return dispose;
	}, []);

	if (isSettingsView) {
		return <SettingsPage />;
	}

	if (state.runtimeStatus !== 'ready') {
		const failed = state.runtimeStatus === 'failed';
		return (
			<div className="runtime-status" role="status" aria-live="polite">
				<div className="runtime-status__icon" aria-hidden="true">云</div>
				<p className="runtime-status__title">{failed ? 'Skill 加载失败' : '正在加载 Skill…'}</p>
				{failed && <p className="runtime-status__message">{state.runtimeMessage || '请查看云效 Agent 日志了解详情。'}</p>}
			</div>
		);
	}

	/** 发送消息：显示拼接文本（引用/Skill 提示），发送原始文本与独立字段。 */
	const handleSend = (text: string, files: WorkspaceFile[], skills: SlashCommand[]): void => {
		if (!state.currentSessionId) {
			return;
		}
		// 用户气泡展示引用文件与已选 Skill（纯文本提示，不污染工具调用路径）
		const displayParts: string[] = [];
		if (files.length > 0) {
			displayParts.push(`引用文件: ${files.map((f) => f.path).join(', ')}`);
		}
		if (skills.length > 0) {
			displayParts.push(`调用 Skill: ${skills.map((s) => `/${s.command}`).join(', ')}`);
		}
		if (text) {
			displayParts.push(text);
		}
		dispatchRef.current({ type: 'userMessageSent', text: displayParts.join('\n') });
		// 文件引用与 Skill 作为独立字段传递，由扩展主进程拼装上下文注入
		post({
			command: 'sendMessage',
			sessionId: state.currentSessionId,
			text,
			files,
			skills: skills.map((s) => s.command),
		});
	};

	/** 追加引用文件（去重）。 */
	const handleAddFile = (file: WorkspaceFile): void => {
		if (state.selectedFiles.some((f) => f.path === file.path)) {
			return;
		}
		dispatchRef.current({ type: 'setSelectedFiles', files: [...state.selectedFiles, file] });
	};

	/** 追加已选 Skill（去重）。 */
	const handleAddSkill = (skill: SlashCommand): void => {
		if (state.selectedSkills.some((s) => s.id === skill.id)) {
			return;
		}
		dispatchRef.current({ type: 'setSelectedSkills', skills: [...state.selectedSkills, skill] });
	};

	return (
		<div className="app">
			<SessionHeader
				currentSessionId={state.currentSessionId}
				sessionTitle={state.sessionTitle}
				sessions={state.sessions}
				onOpenSettings={() => post({ command: 'openSettings' })}
			/>
			<SessionTokenBar payload={state.sessionTokenUsage} />
			<MessageList
				state={state}
				onDeleteUser={(id) => dispatchRef.current({ type: 'deleteUserMessage', messageId: id })}
				onDeleteAssistant={(id) => dispatchRef.current({ type: 'deleteAssistantMessage', messageId: id })}
				onToggleTool={(callId) => dispatchRef.current({ type: 'toggleToolExpand', callId })}
				onToggleDiff={(callId) => dispatchRef.current({ type: 'toggleDiffExpand', callId })}
				onResolveApproval={(callId) => dispatchRef.current({ type: 'approvalResolved', callId })}
			/>
			<ErrorBar message={state.error} onClear={() => dispatchRef.current({ type: 'clearError' })} />
			<MessageInput
				currentSessionId={state.currentSessionId}
				isStreaming={state.isStreaming}
				modelName={state.modelName}
				selectedFiles={state.selectedFiles}
				selectedSkills={state.selectedSkills}
				slashCommandGroups={state.slashCommandGroups}
				workspaceFiles={state.workspaceFiles}
				onRemoveFile={(file) =>
					dispatchRef.current({ type: 'setSelectedFiles', files: state.selectedFiles.filter((f) => f.path !== file.path) })
				}
				onRemoveSkill={(skill) =>
					dispatchRef.current({ type: 'setSelectedSkills', skills: state.selectedSkills.filter((s) => s.id !== skill.id) })
				}
				onAddFile={handleAddFile}
				onAddSkill={handleAddSkill}
				onSend={handleSend}
			/>
		</div>
	);
}
