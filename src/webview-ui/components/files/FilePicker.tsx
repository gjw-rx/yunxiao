/**
 * 工作区文件选择器组件（@ 引用）。
 *
 * 职责：渲染过滤后的工作区文件列表，支持键盘/鼠标选择；选中后移除输入框中的
 * `@查询` 片段并将文件加入已引用列表。
 */
import { useEffect, useRef, type JSX } from 'react';
import type { WorkspaceFile } from '../../protocol';

/** 选择器属性。 */
export interface FilePickerProps {
	/** 过滤后的文件列表 */
	files: WorkspaceFile[];
	/** 当前高亮索引 */
	activeIndex: number;
	/** 选中文件（Enter/鼠标点击） */
	onSelect: (file: WorkspaceFile) => void;
	/** 关闭选择器 */
	onClose: () => void;
}

/** 文件选择器（弹出层）。 */
export function FilePicker({ files, activeIndex, onSelect, onClose }: FilePickerProps): JSX.Element | null {
	const activeOptionRef = useRef<HTMLButtonElement>(null);

	/** 高亮项变更时将其滚动到候选列表的可见区域。 */
	useEffect(() => {
		activeOptionRef.current?.scrollIntoView({ block: 'nearest' });
	}, [activeIndex]);

	if (files.length === 0) {
		return (
			<div id="filePicker" className="show" role="listbox" aria-label="选择工作区文件">
				<div className="file-picker-heading">
					<span>工作区文件</span>
					<span className="file-picker-hint">↑↓ 选择 · Enter 确认 · Esc 关闭</span>
				</div>
				<div className="file-picker-empty">没有匹配的工作区文件</div>
			</div>
		);
	}
	return (
		<div id="filePicker" className="show" role="listbox" aria-label="选择工作区文件">
			<div className="file-picker-heading">
				<span>工作区文件</span>
				<span className="file-picker-hint">↑↓ 选择 · Enter 确认 · Esc 关闭</span>
			</div>
			<div id="filePickerList">
				{files.map((file, index) => (
					<button
						ref={index === activeIndex ? activeOptionRef : null}
						type="button"
						className={`file-option${index === activeIndex ? ' active' : ''}`}
						role="option"
						aria-selected={index === activeIndex}
						key={file.path}
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => onSelect(file)}
					>
						<span className="file-option-icon">▱</span>
						<span className="file-option-path">{file.path}</span>
					</button>
				))}
			</div>
		</div>
	);
}
