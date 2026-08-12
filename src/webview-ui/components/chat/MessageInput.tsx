/**
 * 消息输入组件。
 *
 * 职责：文本输入（Enter 发送 / Shift+Enter 换行）、发送/停止切换、打开文件按钮、
 * 已引用文件与已选 Skill 的 chip 展示与移除，以及 `/` 斜杠命令与 `@` 文件
 * 选择器的触发、过滤与键盘导航（与迁移前行为一致）。
 */
import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { post } from '../../bridge/vscode';
import type { SlashCommand, SlashCommandGroup, WorkspaceFile } from '../../protocol';
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
	/** 已引用文件 */
	selectedFiles: WorkspaceFile[];
	/** 已选 Skill */
	selectedSkills: SlashCommand[];
	/** 斜杠命令分组 */
	slashCommandGroups: SlashCommandGroup[];
	/** 工作区文件（@ 引用候选） */
	workspaceFiles: WorkspaceFile[];
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
	selectedFiles,
	selectedSkills,
	slashCommandGroups,
	workspaceFiles,
	onRemoveFile,
	onRemoveSkill,
	onAddFile,
	onAddSkill,
	onSend,
}: MessageInputProps): JSX.Element {
	const [text, setText] = useState('');
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// ── 选择器状态 ──
	const [slashOpen, setSlashOpen] = useState(false);
	const [slashIndex, setSlashIndex] = useState(0);
	const [filteredSlash, setFilteredSlash] = useState<FilteredSlashCommand[]>([]);
	const [fileOpen, setFileOpen] = useState(false);
	const [fileIndex, setFileIndex] = useState(0);
	const [fileAtStart, setFileAtStart] = useState(-1);
	const [filteredFiles, setFilteredFiles] = useState<WorkspaceFile[]>([]);

	// 输入框自动增高（上限 120px）
	useEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = 'auto';
		el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
	}, [text]);

	/** 关闭两个选择器。 */
	const closePickers = (): void => {
		setSlashOpen(false);
		setFilteredSlash([]);
		setSlashIndex(0);
		setFileOpen(false);
		setFileAtStart(-1);
		setFilteredFiles([]);
		setFileIndex(0);
	};

	// ── / 命令触发 ──
	/** 输入变化时检测 / 与 @ 触发。 */
	const handleInputChange = (value: string, cursorPos: number): void => {
		// Slash 命令：光标在末尾且输入以 / 开头且无空格
		const commandText = value.substring(0, cursorPos);
		if (cursorPos === value.length && commandText.startsWith('/') && !/\s/.test(commandText)) {
			const query = commandText.slice(1).toLowerCase();
			const flat: FilteredSlashCommand[] = [];
			for (const group of slashCommandGroups) {
				for (const cmd of group.commands || []) {
					if (cmd.command.toLowerCase().startsWith(query)) {
						flat.push({ ...cmd, groupLabel: group.label });
					}
				}
			}
			setFilteredSlash(flat);
			setSlashIndex(Math.min(slashIndex, Math.max(flat.length - 1, 0)));
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
		// skill 命令：加入对话框引用块（chip），由用户确认后发送
		if (command.id && command.id.indexOf('skill.') === 0) {
			onAddSkill(command);
			return;
		}
		// 回填命令文本
		setText(`/${command.command}`);
		if (command.send) {
			handleSend(`/${command.command}`);
		} else {
			inputRef.current?.focus();
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
	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
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
					onKeyDown={handleKeyDown}
				/>
			</div>
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
				</div>
				<div className="toolbar-right">
					<div className="model-info">
						<span id="modelName">{modelName || '--'}</span>
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
							className="btn btn-stop btn-icon"
							title="停止"
							aria-label="停止"
							onClick={() => currentSessionId && post({ command: 'stopStream', sessionId: currentSessionId })}
						>
							<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
								<rect x="1" y="1" width="8" height="8" rx="1" />
							</svg>
						</button>
					)}
				</div>
			</div>
			<div id="hint">Enter 发送 &middot; Shift+Enter 换行 &middot; 中文输入法下 Enter 确认候选词 &middot; / 命令 &middot; @ 引用文件</div>
		</div>
	);
}
