/**
 * Diff 卡片组件。
 *
 * 职责：展示 code_edit 的 diff 结果（文件名、增删统计、可展开 diff 表格），
 * 并提供"在差异编辑器中打开"操作。
 */
import { type JSX } from 'react';
import { post } from '../../bridge/vscode';
import type { DiffEntry } from '../../protocol';
import { ChevronIcon, FileIcon } from '../shared/icons';

/** Diff 卡片属性。 */
export interface DiffCardProps {
	/** Diff 条目 */
	entry: DiffEntry;
	/** 点击头部展开/收起 */
	onToggle: () => void;
}

/** Diff 卡片。 */
export function DiffCard({ entry, onToggle }: DiffCardProps): JSX.Element {
	return (
		<div className={`diff-card${entry.expanded ? ' expanded' : ''}`}>
			<div
				className="diff-header"
				role="button"
				tabIndex={0}
				aria-expanded={entry.expanded}
				onClick={onToggle}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						onToggle();
					}
				}}
			>
				<span className="diff-icon">
					<FileIcon />
				</span>
				<span className="diff-filename">{entry.file_path}</span>
				<span className="diff-stats">
					<span className="diff-additions">+{entry.additions || 0}</span>
					<span className="diff-deletions">-{entry.deletions || 0}</span>
				</span>
				<span className="diff-chevron">
					<ChevronIcon />
				</span>
			</div>
			{entry.expanded && (
				<div className="diff-body">
					<div className="diff-content">
						{/* diff_html 由宿主生成，仅含结构化的 diff 表格行（经转义），无脚本 */}
						<table className="diff-table" dangerouslySetInnerHTML={{ __html: entry.diff_html || '' }} />
					</div>
					<div className="diff-footer">
						<a
							role="button"
							tabIndex={0}
							onClick={() => post({ command: 'openDiff', file_path: entry.file_path })}
							onKeyDown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									post({ command: 'openDiff', file_path: entry.file_path });
								}
							}}
						>
							在差异编辑器中打开 →
						</a>
					</div>
				</div>
			)}
		</div>
	);
}
