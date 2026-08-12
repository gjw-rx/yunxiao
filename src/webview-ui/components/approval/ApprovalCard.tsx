/**
 * 审批卡片组件。
 *
 * 职责：展示工具审批请求（工具名、摘要、文件路径），提供允许一次/始终允许/拒绝
 * 按钮；决定作出后回传宿主并标记 `resolved` 退场（不留在时间线）。
 */
import { useCallback, useState, type JSX } from 'react';
import { post } from '../../bridge/vscode';
import type { ApprovalDecision, ApprovalEntry } from '../../protocol';
import { ApprovalIcon, ToolIcon } from '../shared/icons';

/** 审批卡片属性。 */
export interface ApprovalCardProps {
	/** 审批条目 */
	entry: ApprovalEntry;
	/** 决定已作出（宿主回传 approvalDecision 后由 reducer 标记退场） */
	onResolve: () => void;
}

/** 审批卡片。 */
export function ApprovalCard({ entry, onResolve }: ApprovalCardProps): JSX.Element {
	const [open, setOpen] = useState(false);
	const [clipped, setClipped] = useState(false);

	/** 提交审批决定并退场。 */
	const decide = (decision: ApprovalDecision): void => {
		post({ command: 'approvalDecision', call_id: entry.call_id, decision });
		onResolve();
	};

	// 入 DOM 后检测摘要是否超长（长摘要如 diff 折起，需要时再展开）
	const summaryRef = useCallback((el: HTMLDivElement | null): void => {
		if (el && el.scrollHeight > el.clientHeight + 4) {
			setClipped(true);
		}
	}, []);

	return (
		<div className={`approval-card${entry.resolved ? ' resolving' : ''}`} role="alert">
			<div className="approval-header">
				<span className="approval-icon">
					<ApprovalIcon />
				</span>
				<div className="approval-content">
					<div className="approval-tool-name">
						<span className="step-icon">
							<ToolIcon tool={entry.tool_name} />
						</span>
						{entry.tool_name}
						<span className="approval-kicker">待确认</span>
					</div>
					<div
						className={`approval-summary${open ? ' open' : ''}${clipped && !open ? ' clipped' : ''}`}
						ref={summaryRef}
					>
						{entry.summary}
					</div>
					{clipped && (
						<button
							type="button"
							className="approval-more"
							onClick={() => setOpen(!open)}
							aria-expanded={open}
						>
							{open ? '收起' : '展开全部'}
						</button>
					)}
					{entry.file_path && <div className="approval-file-path">{entry.file_path}</div>}
				</div>
			</div>
			<div className="approval-actions">
				<button type="button" className="approval-btn allow" onClick={() => decide('allow')}>
					允许一次
				</button>
				<button type="button" className="approval-btn always" onClick={() => decide('always')}>
					始终允许
				</button>
				<button type="button" className="approval-btn deny" onClick={() => decide('deny')}>
					拒绝
				</button>
			</div>
		</div>
	);
}
