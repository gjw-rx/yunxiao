/**
 * 斜杠命令选择器组件。
 *
 * 职责：渲染过滤后的斜杠命令分组列表（分组标题 + 命令项），支持键盘/鼠标选择；
 * 命令 `action`（newSession/stopStream）直接触发，skill 命令加入对话框，其余回填输入框。
 */
import { useEffect, useRef, type JSX } from 'react';
import type { SlashCommand } from '../../protocol';

/** 带分组标签的过滤命令。 */
export interface FilteredSlashCommand extends SlashCommand {
	/** 所属分组展示名 */
	groupLabel: string;
}

/** 选择器属性。 */
export interface SlashCommandPickerProps {
	/** 过滤后的命令（含分组标签） */
	commands: FilteredSlashCommand[];
	/** 当前高亮索引 */
	activeIndex: number;
	/** 选中命令（Enter/鼠标点击） */
	onSelect: (command: FilteredSlashCommand) => void;
	/** 关闭选择器 */
	onClose: () => void;
}

/** 斜杠命令选择器（弹出层）。 */
export function SlashCommandPicker({ commands, activeIndex, onSelect, onClose }: SlashCommandPickerProps): JSX.Element | null {
	const activeOptionRef = useRef<HTMLButtonElement>(null);

	/** 高亮项变更时将其滚动到候选列表的可见区域。 */
	useEffect(() => {
		activeOptionRef.current?.scrollIntoView({ block: 'nearest' });
	}, [activeIndex]);

	if (commands.length === 0) return null;

	// 按分组标签聚合渲染：分组标题 + 组内命令
	const byGroup = new Map<string, FilteredSlashCommand[]>();
	for (const cmd of commands) {
		const list = byGroup.get(cmd.groupLabel) ?? [];
		list.push(cmd);
		byGroup.set(cmd.groupLabel, list);
	}

	let idx = 0;
	const rows: JSX.Element[] = [];
	for (const [label, group] of byGroup) {
		rows.push(
			<div className="slash-command-group-label" key={label}>
				{label}
			</div>
		);
		for (const command of group) {
			// 提示区分三类选中行为：command 生成 Command 引用块、skill/agent 生成 Skill 引用块、基础命令回车直达
			const keyHint = command.kind === 'command' ? '↵ 选择' : command.kind === 'skill' || command.kind === 'agent' ? '↵ 加入对话框' : 'Enter';
			rows.push(
				<button
					ref={idx === activeIndex ? activeOptionRef : null}
					type="button"
					className={`slash-command-option${idx === activeIndex ? ' active' : ''}`}
					role="option"
					aria-selected={idx === activeIndex}
					key={command.id}
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => onSelect(command)}
				>
					<span className="slash-command-icon">/</span>
					<span className="slash-command-copy">
						<span className="slash-command-name">{command.label}</span>
						<span className="slash-command-description">{command.description || ''}</span>
					</span>
					<span className="slash-command-key">{keyHint}</span>
				</button>
			);
			idx += 1;
		}
	}

	return (
		<div id="slashCommandPicker" className="show" role="listbox" aria-label="选择 Slash 命令">
			<div className="file-picker-heading">
				<span>Slash 命令</span>
				<span className="file-picker-hint">↑↓ 选择 · Enter 执行 · Esc 关闭</span>
			</div>
			<div id="slashCommandList">{rows}</div>
		</div>
	);
}
