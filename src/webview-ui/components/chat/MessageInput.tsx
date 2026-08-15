/**
 * 消息输入组件。
 *
 * 职责：文本输入（Enter 发送 / Shift+Enter 换行）、发送/停止切换、打开文件按钮、
 * 已引用文件与已选 Skill 的 chip 展示与移除，以及 `/` 斜杠命令与 `@` 文件
 * 选择器的触发、过滤与键盘导航（与迁移前行为一致）。
 */
import { useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { post } from '../../bridge/vscode';
import type { ApprovalMode, ModelPickerItem, SlashCommand, SlashCommandGroup, WorkspaceFile } from '../../protocol';
import { findSlashCommandToken, type SlashCommandToken } from '../../utils/chatBehavior';
import { SlashCommandPicker, type FilteredSlashCommand } from '../commands/SlashCommandPicker';
import { FilePicker } from '../files/FilePicker';

/** 输入组件属性。 */
export interface MessageInputProps {
	/** 当前会话 ID（null 时输入禁用） */
	currentSessionId: string | null;
	/** 是否正在流式回复 */
	isStreaming: boolean;
	/** 模型名称 */
	modelName: string;
	/** 当前工作区审批模式。 */
	approvalMode: ApprovalMode;
	/** 已启用模型的选择弹窗候选项 */
	modelProfiles: readonly ModelPickerItem[];
	/** 已引用文件 */
	selectedFiles: WorkspaceFile[];
	/** 已选 Skill */
	selectedSkills: SlashCommand[];
	/** 斜杠命令分组 */
	slashCommandGroups: SlashCommandGroup[];
	/** 工作区文件（@ 引用候选） */
	workspaceFiles: WorkspaceFile[];
	/** 回滚后待回填输入框的文本（值变化时覆盖当前输入） */
	draftText?: string;
	/** 已消费 draftText（回填完成），用于通知 reducer 清空待回填文本 */
	onDraftConsumed: () => void;
	/** 移除引用文件 */
	onRemoveFile: (file: WorkspaceFile) => void;
	/** 移除已选 Skill */
	onRemoveSkill: (skill: SlashCommand) => void;
	/** 选中 @ 文件：加入已引用列表 */
	onAddFile: (file: WorkspaceFile) => void;
	/** 选中 skill 命令：加入已选列表（不直接发送） */
	onAddSkill: (skill: SlashCommand) => void;
	/** 发送消息（由 App 组装引用/Skill 显示文本并 post sendMessage） */
	onSend: (text: string, files: WorkspaceFile[], skills: SlashCommand[]) => void;
}

/** 输入区：发送/停止、文件/Skill 引用与命令/文件选择器。 */
export function MessageInput({
	currentSessionId,
	isStreaming,
	modelName,
	approvalMode,
	modelProfiles,
	selectedFiles,
	selectedSkills,
	slashCommandGroups,
	workspaceFiles,
	draftText,
	onDraftConsumed,
	onRemoveFile,
	onRemoveSkill,
	onAddFile,
	onAddSkill,
	onSend,
}: MessageInputProps): JSX.Element {
	const [text, setText] = useState('');
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const modelPickerRef = useRef<HTMLDivElement>(null);
	const approvalModeRef = useRef<HTMLDivElement>(null);

	// ── 选择器状态 ──
	const [slashOpen, setSlashOpen] = useState(false);
	const [slashIndex, setSlashIndex] = useState(0);
	const [filteredSlash, setFilteredSlash] = useState<FilteredSlashCommand[]>([]);
	const [slashToken, setSlashToken] = useState<SlashCommandToken | null>(null);
	const [fileOpen, setFileOpen] = useState(false);
	const [fileIndex, setFileIndex] = useState(0);
	const [fileAtStart, setFileAtStart] = useState(-1);
	const [filteredFiles, setFilteredFiles] = useState<WorkspaceFile[]>([]);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [approvalModeOpen, setApprovalModeOpen] = useState(false);

	// 输入框自动增高（上限 160px）
	useEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = 'auto';
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
	}, [text]);

	// 回滚回填：draftText 变化时覆盖输入框内容（仅回填，不触发选择器），消费后通知 reducer 清空
	useEffect(() => {
		if (draftText !== undefined && draftText !== '') {
			setText(draftText);
			onDraftConsumed();
			requestAnimationFrame(() => {
				inputRef.current?.focus();
			});
		}
	}, [draftText, onDraftConsumed]);

	// 模型选择弹窗打开时，点击外部或按 Esc 关闭弹窗
	useEffect(() => {
		if (!modelPickerOpen && !approvalModeOpen) return;
		const closeOnOutsideClick = (event: MouseEvent): void => {
			if (
				!modelPickerRef.current?.contains(event.target as Node) &&
				!approvalModeRef.current?.contains(event.target as Node)
			) {
				setModelPickerOpen(false);
				setApprovalModeOpen(false);
			}
		};
		const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
			if (event.key === 'Escape') {
				setModelPickerOpen(false);
				setApprovalModeOpen(false);
			}
		};
		document.addEventListener('mousedown', closeOnOutsideClick);
		document.addEventListener('keydown', closeOnEscape);
		return () => {
			document.removeEventListener('mousedown', closeOnOutsideClick);
			document.removeEventListener('keydown', closeOnEscape);
		};
	}, [modelPickerOpen, approvalModeOpen]);

	/** 切换模型选择弹窗并在打开时请求最新已启用模型列表。 */
	const toggleModelPicker = (): void => {
		if (modelPickerOpen) {
			setModelPickerOpen(false);
			return;
		}
		setModelPickerOpen(true);
		post({ command: 'requestModelPicker' });
	};

	/** 提交选中的模型 ID，并关闭模型选择弹窗。 */
	const selectModel = (modelId: string): void => {
		setModelPickerOpen(false);
		post({ command: 'selectModel', modelId });
	};

	/** 切换审批模式菜单的展开状态。 */
	const toggleApprovalMode = (): void => {
		setApprovalModeOpen((open) => !open);
		setModelPickerOpen(false);
	};

	/** 提交审批模式切换请求，最终状态以宿主回推为准。 */
	const selectApprovalMode = (mode: ApprovalMode): void => {
		setApprovalModeOpen(false);
		post({ command: 'setApprovalMode', mode });
	};

	/** 关闭两个选择器。 */
	const closePickers = (): void => {
		setSlashOpen(false);
		setFilteredSlash([]);
		setSlashIndex(0);
		setSlashToken(null);
		setFileOpen(false);
		setFileAtStart(-1);
		setFilteredFiles([]);
		setFileIndex(0);
	};

	// ── / 命令触发 ──
	/** 输入变化时检测 / 与 @ 触发。 */
	const handleInputChange = (value: string, cursorPos: number): void => {
		// Slash 命令：支持出现在任意词间，且替换时覆盖完整命令片段
		const commandToken = findSlashCommandToken(value, cursorPos);
		if (commandToken) {
			const query = commandToken.query.toLowerCase();
			const flat: FilteredSlashCommand[] = [];
			for (const group of slashCommandGroups) {
				for (const cmd of group.commands || []) {
					if (cmd.command.toLowerCase().startsWith(query)) {
						flat.push({ ...cmd, groupLabel: group.label });
					}
				}
			}
			setFilteredSlash(flat);
			setSlashIndex(0);
			setSlashToken(commandToken);
			setSlashOpen(flat.length > 0);
			setFileOpen(false);
			return;
		}
		// @ 文件触发
		const atStart = value.substring(0, cursorPos).lastIndexOf('@');
		const prefix = atStart >= 0 ? value.charAt(atStart - 1) : '';
		const afterAt = value.substring(0, cursorPos).slice(atStart + 1);
		if (atStart >= 0 && (!prefix || /\s/.test(prefix)) && !/\s/.test(afterAt)) {
			setFileAtStart(atStart);
			setSlashOpen(false);
			if (workspaceFiles.length === 0) post({ command: 'requestWorkspaceFiles' });
			setFilteredFiles(
				workspaceFiles.filter((f) => f.path.toLowerCase().includes(afterAt.toLowerCase())).slice(0, 80)
			);
			setFileIndex(Math.min(fileIndex, Math.max(filteredFiles.length - 1, 0)));
			setFileOpen(true);
			return;
		}
		// 无触发条件：关闭选择器
		closePickers();
	};

	/** 选择文件：移除 @查询 片段并加入引用列表。 */
	const selectFile = (file: WorkspaceFile): void => {
		if (fileAtStart < 0) return;
		const cursorPos = inputRef.current?.selectionStart ?? text.length;
		const before = text.substring(0, fileAtStart);
		const after = text.substring(cursorPos);
		setText(before + after);
		requestAnimationFrame(() => {
			const el = inputRef.current;
			if (el) el.setSelectionRange(before.length, before.length);
		});
		if (!selectedFiles.some((s) => s.path === file.path)) {
			onAddFile(file);
		}
		closePickers();
	};

	/** 选择斜杠命令。 */
	const selectSlashCommand = (command: FilteredSlashCommand): void => {
		const token = slashToken;
		closePickers();
		// 特殊动作：直接触发扩展侧命令
		if (command.action === 'newSession') {
			post({ command: 'createSession' });
			return;
		}
		if (command.action === 'stopStream') {
			if (currentSessionId) post({ command: 'stopStream', sessionId: currentSessionId });
			return;
		}
		if (command.action === 'switchModel') {
			post({ command: 'switchModel' });
			return;
		}
		if (command.action === 'compactContext') {
			if (currentSessionId) post({ command: 'compactContext', sessionId: currentSessionId });
			return;
		}
		// skill 命令：加入对话框引用块（chip），由用户确认后发送
		if (command.id && command.id.indexOf('skill.') === 0) {
			if (token) {
				const nextText = text.slice(0, token.start) + text.slice(token.end);
				setText(nextText);
				requestAnimationFrame(() => inputRef.current?.setSelectionRange(token.start, token.start));
			}
			onAddSkill(command);
			return;
		}
		// 回填命令文本，并保留命令前后的普通输入
		const nextText = token
			? `${text.slice(0, token.start)}/${command.command}${text.slice(token.end)}`
			: `/${command.command}`;
		setText(nextText);
		if (command.send) {
			handleSend(nextText);
		} else {
			requestAnimationFrame(() => {
				inputRef.current?.focus();
				const position = token ? token.start + command.command.length + 1 : nextText.length;
				inputRef.current?.setSelectionRange(position, position);
			});
		}
	};

	/** 发送：原始用户文本 + 引用/Skill 交由 App 组装显示与发送。 */
	const handleSend = (overrideText?: string): void => {
		const userText = (overrideText ?? text).trim();
		const files = selectedFiles.slice();
		const skills = selectedSkills.slice();
		if ((!userText && files.length === 0 && skills.length === 0) || !currentSessionId || isStreaming) return;

		onSend(userText, files, skills);
		setText('');
		closePickers();
		inputRef.current?.focus();
	};

	/** 键盘处理：优先响应选择器（上下/Enter/Esc），其次 Enter 发送。 */
	const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
		if (slashOpen) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				if (filteredSlash.length === 0) return;
				setSlashIndex(
					(slashIndex + (e.key === 'ArrowDown' ? 1 : -1) + filteredSlash.length) % filteredSlash.length
				);
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				selectSlashCommand(filteredSlash[slashIndex]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				closePickers();
				return;
			}
		}
		if (fileOpen) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				if (filteredFiles.length === 0) return;
				setFileIndex(
					(fileIndex + (e.key === 'ArrowDown' ? 1 : -1) + filteredFiles.length) % filteredFiles.length
				);
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				selectFile(filteredFiles[fileIndex]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				closePickers();
				return;
			}
		}
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			handleSend();
		}
	};

	return (
		<div id="inputArea">
			{slashOpen && (
				<SlashCommandPicker
					commands={filteredSlash}
					activeIndex={slashIndex}
					onSelect={selectSlashCommand}
					onClose={closePickers}
				/>
			)}
			{fileOpen && (
				<FilePicker files={filteredFiles} activeIndex={fileIndex} onSelect={selectFile} onClose={closePickers} />
			)}
			<div id="inputWrapper">
				{selectedFiles.length > 0 && (
					<div id="fileReferenceList" className="file-reference-list" aria-label="已引用文件">
						{selectedFiles.map((file, index) => {
							const extension = file.name.includes('.') ? file.name.split('.').pop()!.slice(0, 3) : 'file';
							return (
								<span className="file-reference-chip" title={file.path} key={`${file.path}-${index}`}>
									<span className="file-reference-extension">{extension}</span>
									<span className="file-reference-name">{file.name}</span>
									<button
										type="button"
										className="file-reference-remove"
										aria-label={`取消引用 ${file.name}`}
										title="取消引用"
										onClick={() => onRemoveFile(file)}
									>
										&times;
									</button>
								</span>
							);
						})}
					</div>
				)}
				{selectedSkills.length > 0 && (
					<div id="skillReferenceList" className="file-reference-list skill-reference-list" aria-label="已选 Skill">
						{selectedSkills.map((skill, index) => (
							<span className="skill-reference-chip" title={skill.description || ''} key={`${skill.id}-${index}`}>
								<span className="skill-reference-prefix">/</span>
								<span className="skill-reference-name">{skill.label}</span>
								<button
									type="button"
									className="file-reference-remove"
									aria-label={`移除 Skill ${skill.label}`}
									title="移除"
									onClick={() => onRemoveSkill(skill)}
								>
									&times;
								</button>
							</span>
						))}
					</div>
				)}
				<textarea
					id="input"
					ref={inputRef}
					rows={1}
					value={text}
					placeholder="输入消息... 使用 @ 引用文件"
					aria-label="消息输入"
					disabled={isStreaming || !currentSessionId}
					onChange={(e) => {
						setText(e.target.value);
						handleInputChange(e.target.value, e.target.selectionStart ?? e.target.value.length);
					}}
					onSelect={(e) => handleInputChange(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
					onKeyDown={handleKeyDown}
				/>
				<div id="inputToolbar" className="input-toolbar">
					<div className="toolbar-left">
						<button
							type="button"
							id="openFileBtn"
							className="btn btn-icon open-file-btn"
							title="打开文件"
							aria-label="打开文件"
							disabled={isStreaming}
							onClick={() => post({ command: 'openFile' })}
						>
							<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
								<path d="M8 2v12M2 8h12" />
							</svg>
						</button>
						<div className={`approval-mode${approvalMode === 'full-access' ? ' is-full-access' : ''}`} ref={approvalModeRef}>
							<button
								type="button"
								id="approvalModeButton"
								className="approval-mode-trigger"
								title={approvalMode === 'full-access' ? '完全访问：非删除操作将自动批准' : '请求批准：操作前会请求确认'}
								aria-label={approvalMode === 'full-access' ? '当前审批模式：完全访问' : '当前审批模式：请求批准'}
								aria-haspopup="menu"
								aria-expanded={approvalModeOpen}
								onClick={toggleApprovalMode}
							>
								<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
									<path d="M8 1.75 13 3.7v3.7c0 3.15-2.1 5.75-5 6.85-2.9-1.1-5-3.7-5-6.85V3.7L8 1.75Z" />
									<path d="m5.75 8 1.5 1.5 3-3" />
								</svg>
								<span>{approvalMode === 'full-access' ? '完全访问' : '请求批准'}</span>
								<svg className="approval-mode-chevron" viewBox="0 0 12 12" aria-hidden="true">
									<path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
								</svg>
							</button>
							{approvalModeOpen && (
								<div className="approval-mode-menu" role="menu" aria-label="选择审批模式">
									<button type="button" role="menuitemradio" aria-checked={approvalMode === 'request'} className={`approval-mode-option${approvalMode === 'request' ? ' selected' : ''}`} onClick={() => selectApprovalMode('request')}>
										<span className="approval-mode-option-title">请求批准</span>
										<small>编辑、执行等操作会在执行前请求确认</small>
									</button>
									<button type="button" role="menuitemradio" aria-checked={approvalMode === 'full-access'} className={`approval-mode-option approval-mode-option-danger${approvalMode === 'full-access' ? ' selected' : ''}`} onClick={() => selectApprovalMode('full-access')}>
										<span className="approval-mode-option-title">完全访问</span>
										<small>非删除操作自动批准；删除操作仍需确认</small>
									</button>
								</div>
							)}
						</div>
					</div>
					<div className="toolbar-right">
						<div className="model-info" ref={modelPickerRef}>
							<button
								type="button"
								id="modelName"
								className="model-switch-button"
								disabled={isStreaming || !modelName}
								title="切换模型"
								aria-label={`切换模型 ${modelName || '--'}`}
								aria-haspopup="menu"
								aria-expanded={modelPickerOpen}
								onClick={toggleModelPicker}
							>
								<span>{modelName || '--'}</span>
								<svg viewBox="0 0 12 12" aria-hidden="true">
									<path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
								</svg>
							</button>
							{modelPickerOpen && (
								<div className="model-picker" role="menu" aria-label="选择模型">
									{modelProfiles.length === 0 ? (
										<div className="model-picker-empty" role="status">正在加载模型…</div>
									) : (
										modelProfiles.map((profile) => (
											<button
												type="button"
												key={profile.id}
												className={`model-picker-item${profile.isDefault ? ' selected' : ''}`}
												role="menuitem"
												aria-label={profile.model}
												onClick={() => selectModel(profile.id)}
											>
												<span className="model-picker-name">{profile.model}</span>
												<span className="model-picker-provider">{profile.provider}</span>
												{profile.isDefault && <span className="model-picker-check" aria-label="当前模型">✓</span>}
											</button>
										))
									)}
								</div>
							)}
						</div>
						{!isStreaming ? (
							<button
								type="button"
								id="sendBtn"
								className="btn btn-icon"
								disabled={!currentSessionId || (!text.trim() && selectedFiles.length === 0 && selectedSkills.length === 0)}
								title="发送 (Enter)"
								aria-label="发送"
								onClick={() => handleSend()}
							>
								<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
									<path d="M1.5 1.5l13 6.5-13 6.5V8.75l8-1.25-8-1.25V1.5z" />
								</svg>
							</button>
						) : (
							<button
								type="button"
								id="stopBtn"
								className="btn btn-stop stop-generation-button"
								disabled={!currentSessionId}
								title="停止生成"
								aria-label="停止生成"
								onClick={() => currentSessionId && post({ command: 'stopStream', sessionId: currentSessionId })}
							>
								<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
									<rect x="1" y="1" width="8" height="8" rx="1" />
								</svg>
								<span className="stop-generation-button__label">停止生成</span>
							</button>
						)}
					</div>
				</div>
			</div>
			<div id="hint">Enter 发送 &middot; Shift+Enter 换行 &middot; 中文输入法下 Enter 确认候选词 &middot; / 命令 &middot; @ 引用文件</div>
		</div>
	);
}
