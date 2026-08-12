/**
 * 共享 SVG 图标组件（从旧 chatPanel.ts `_getJs()` 的 getToolIconSvg/getStatusIcon 迁移）。
 *
 * 职责：按工具名与状态渲染时间线、审批、Diff 等场景的内联 SVG 图标。
 */
import type { JSX } from 'react';
import type { ToolState } from '../../protocol';

/** 按工具名挑选对应的图标（文件名/编辑/搜索/终端/Git 等）。 */
export function ToolIcon({ tool }: { tool: string }): JSX.Element {
	const name = (tool || '').toLowerCase();
	if (name.includes('read') || name.includes('file')) {
		return (
			<svg viewBox="0 0 16 16" fill="currentColor">
				<path d="M9 1H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V5L9 1zM4 14V2h4v4h4v8H4z" />
			</svg>
		);
	}
	if (name.includes('edit') || name.includes('write')) {
		return (
			<svg viewBox="0 0 16 16" fill="currentColor">
				<path d="M12.147 1.146a.5.5 0 0 1 .707 0l2 2a.5.5 0 0 1 0 .708l-9 9a.5.5 0 0 1-.232.138l-4 1a.5.5 0 0 1-.6-.6l1-4a.5.5 0 0 1 .138-.233l9-9zM4.5 11.5l-.793 2.293L6 13h5V8H6v3.5zM12 3.707L11.293 3 9 5.293 9.707 6 12 3.707z" />
			</svg>
		);
	}
	if (name.includes('search') || name.includes('find')) {
		return (
			<svg viewBox="0 0 16 16" fill="currentColor">
				<path d="M11.5 6.5a5 5 0 1 1-10 0 5 5 0 0 1 10 0zm-.707 4.096a6 6 0 1 1 .707-.707l3.207 3.207-.707.707-3.207-3.207z" />
			</svg>
		);
	}
	if (name.includes('delete') || name.includes('remove')) {
		return (
			<svg viewBox="0 0 16 16" fill="currentColor">
				<path d="M6 1h4v1h3v1H3V2h3V1zM4 4h8v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4zm2 2v7h1V6H6zm3 0v7h1V6H9z" />
			</svg>
		);
	}
	if (name.includes('move') || name.includes('rename')) {
		return (
			<svg viewBox="0 0 16 16" fill="currentColor">
				<path d="M7.5 1L11 4.5H9v4H7v-4H5L7.5 1zM5 15l3.5-3.5H7v-4h2v4h2.5L7.5 15H5z" />
			</svg>
		);
	}
	if (name.includes('list') || name.includes('dir')) {
		return (
			<svg viewBox="0 0 16 16" fill="currentColor">
				<path d="M2 2h6v2H2V2zm0 4h12v2H2V6zm0 4h12v2H2v-2zm0 4h8v2H2v-2z" />
			</svg>
		);
	}
	if (name.includes('diff')) {
		return (
			<svg viewBox="0 0 16 16" fill="currentColor">
				<path d="M8 1v14M1 8h14" stroke="currentColor" strokeWidth="1" fill="none" />
				<path d="M5 4h6v1H5V4zm0 3h6v1H5V7zm0 3h4v1H5v-1z" />
			</svg>
		);
	}
	if (name.includes('terminal') || name.includes('exec')) {
		return (
			<svg viewBox="0 0 16 16" fill="currentColor">
				<path d="M1 2h14v12H1V2zm1 2v8h12V4H2zm2 1.5L5.5 7 4 8.5V5.5zm0 3L5.5 10 4 11.5v-3zM7 9h4v1H7V9z" />
			</svg>
		);
	}
	if (
		name.includes('git') ||
		name.includes('commit') ||
		name.includes('branch') ||
		name.includes('stash') ||
		name.includes('status')
	) {
		return (
			<svg viewBox="0 0 16 16" fill="currentColor">
				<path d="M5 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm10 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM7 3H5.9a3 3 0 0 1 0 6h4.2a3 3 0 0 1 0 6H11v2H9v-4h1a1 1 0 0 0 0-2H5.9a5 5 0 0 0 0-10H7V1l3 2.5L7 6V3z" />
			</svg>
		);
	}
	// 默认齿轮图标
	return (
		<svg viewBox="0 0 16 16" fill="currentColor">
			<path d="M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm4.9 1.3l1.8-.5-.5-1.8-1.7.6a5 5 0 0 0-1.5-.9l-.4-1.8h-2l-.4 1.8a5 5 0 0 0-1.5.9l-1.7-.6-.5 1.8 1.8.5a5 5 0 0 0 0 1.8l-1.8.5.5 1.8 1.7-.6a5 5 0 0 0 1.5.9l.4 1.8h2l.4-1.8a5 5 0 0 0 1.5-.9l1.7.6.5-1.8-1.8-.5a5 5 0 0 0 0-1.8z" />
		</svg>
	);
}

/** 按工具状态渲染状态图标（spinner / 成功 / 错误 / 待处理）。 */
export function StatusIcon({ state }: { state: ToolState }): JSX.Element {
	switch (state) {
		case 'running':
			return <div className="spinner" role="img" aria-label="执行中" />;
		case 'success':
			return (
				<svg viewBox="0 0 16 16" fill="currentColor" className="step-status-icon">
					<path d="M6.5 10.5L3.5 7.5l-.7.7L6.5 12l7-7-.7-.7-6.3 6.2z" />
				</svg>
			);
		case 'error':
			return (
				<svg viewBox="0 0 16 16" fill="currentColor" className="step-status-icon">
					<path d="M8 1a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm3.5 9.5L10 11.5 8 9.5 6 11.5 4.5 10l2-2-2-2L6 4.5l2 2 2-2 1.5 1.5-2 2 2 2z" />
				</svg>
			);
		case 'pending':
		default:
			return (
				<svg viewBox="0 0 16 16" fill="currentColor" className="step-status-icon is-pending">
					<path d="M8 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 1a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm-1 1v5l4 2.5.7-1-3.7-2.2V4H7z" />
				</svg>
			);
	}
}

/** 下拉箭头。 */
export function ChevronIcon(): JSX.Element {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor">
			<path d="M4 6l4 4 4-4H4z" />
		</svg>
	);
}

/** 审批警示图标。 */
export function ApprovalIcon(): JSX.Element {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor">
			<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
		</svg>
	);
}

/** 文件（Diff）图标。 */
export function FileIcon(): JSX.Element {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor">
			<path d="M8.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6.5L8.5 1zM9 2.5L12.5 6H9V2.5zM5 14V2h3v5h5v7H5z" />
		</svg>
	);
}

/** 思考图标。 */
export function ThoughtIcon(): JSX.Element {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor">
			<path d="M8 1a5 5 0 0 1 4.9 4.1A3.5 3.5 0 0 1 12.5 12H11v-1h1.5a2.5 2.5 0 0 0 .4-4.97A4 4 0 1 0 4 6.5a3 3 0 0 0-.5 5.97V13h1v-.5A3 3 0 0 0 7 9.5 3.5 3.5 0 0 1 8 2.5z" />
		</svg>
	);
}

/** 计划图标。 */
export function PlanIcon(): JSX.Element {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor">
			<path d="M1 3h10v1H1V3zm0 4h10v1H1V7zm0 4h7v1H1v-1zm12-7v5h1V4h-1zm0 6v3h1v-3h-1z" />
		</svg>
	);
}
