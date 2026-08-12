/**
 * 工具时间线步骤组件。
 *
 * 职责：按 `call_id` 渲染单个工具步骤（pending/running/success/error），
 * 展示工具名、参数行内预览与可展开详情（参数/错误/结果）。
 */
import { type JSX } from 'react';
import type { ToolEntry } from '../../protocol';
import { summarizeArgs, stringifyValue, truncateText } from '../../state/reducer';
import { ChevronIcon, StatusIcon, ToolIcon } from '../shared/icons';

/** 工具步骤属性。 */
export interface ToolStepProps {
	/** 工具时间线条目 */
	entry: ToolEntry;
	/** 点击展开/收起详情 */
	onToggle: () => void;
}

/** 单个工具时间线步骤。 */
export function ToolStep({ entry, onToggle }: ToolStepProps): JSX.Element {
	const argPreview = summarizeArgs(entry.args);
	return (
		<div className={`step tool clickable ${entry.state}${entry.expanded ? ' expanded' : ''}`}>
			<span className="step-dot" aria-hidden="true" />
			<div
				className="step-head"
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
				<span className="step-icon">
					<ToolIcon tool={entry.tool} />
				</span>
				<span className="step-name">{entry.tool}</span>
				{argPreview && <span className="step-arg">{argPreview}</span>}
				<span className="step-status">
					<StatusIcon state={entry.state} />
				</span>
				<span className="step-chevron">
					<ChevronIcon />
				</span>
			</div>
			{entry.expanded && (
				<div className="step-detail">
					{entry.args !== undefined && entry.args !== null && (
						<>
							<div className="detail-label">参数</div>
							<div className="detail-block">{truncateText(stringifyValue(entry.args), 1200)}</div>
						</>
					)}
					{entry.error ? (
						<>
							<div className="detail-label">错误</div>
							<div className="detail-block is-error">{entry.error}</div>
						</>
					) : (
						entry.output !== undefined &&
						entry.output !== null && (
							<>
								<div className="detail-label">结果</div>
								<div className="detail-block">{truncateText(stringifyValue(entry.output), 2000)}</div>
							</>
						)
					)}
				</div>
			)}
		</div>
	);
}
