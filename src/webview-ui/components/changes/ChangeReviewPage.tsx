/**
 * 代码变更查看页 - 展示一次最终回复关联的文件列表，并按需加载前后快照进行对照。
 */
import { useEffect, useState, type JSX } from 'react';
import { post, subscribe } from '../../bridge/vscode';
import type { ChangeReviewFileDetail, ChangeReviewSummary, HostToWebviewMessage } from '../../protocol';

/**
 * 代码变更查看页。
 * @returns 代码变更页面元素。
 */
export function ChangeReviewPage(): JSX.Element {
	const [summary, setSummary] = useState<ChangeReviewSummary | undefined>();
	const [selected, setSelected] = useState<ChangeReviewFileDetail | undefined>();

	useEffect(() => {
		const dispose = subscribe((message: HostToWebviewMessage) => {
			if (message.command === 'changeReviewSummary') {
				setSummary(message.summary);
				setSelected(undefined);
			} else if (message.command === 'changeReviewFile') {
				setSelected(message.file);
			}
		});
		post({ command: 'requestChangeReview' });
		return dispose;
	}, []);

	if (!summary) {
		return <main className="change-review-page change-review-empty">未找到本次回复的代码变更记录。</main>;
	}

	return (
		<main className="change-review-page">
			<header className="change-review-header">
				<div>
					<span className="change-review-kicker">本次回复</span>
					<h1>代码变更</h1>
				</div>
				<div className="change-review-total">{summary.fileCount} 个文件 <em>+{summary.additions}</em> <i>-{summary.deletions}</i></div>
			</header>
			{selected ? (
				<ChangeDetail file={selected} onBack={() => setSelected(undefined)} />
			) : (
				<section className="change-file-list" aria-label="变更文件列表">
					{summary.files.map((file) => (
						<button key={file.id} type="button" className="change-file-row" onClick={() => post({ command: 'requestChangeReviewFile', fileId: file.id })}>
							<span className={`change-file-status ${file.status}`}>{statusLabel(file.status)}</span>
							<span className="change-file-path">{file.relativePath}</span>
							<span className="change-file-stats"><em>+{file.additions}</em> <i>-{file.deletions}</i></span>
						</button>
					))}
				</section>
			)}
		</main>
	);
}

/**
 * 文件变更详情。
 * @param props 文件详情和返回动作。
 * @returns 文件对照页面元素。
 */
function ChangeDetail({ file, onBack }: { file: ChangeReviewFileDetail; onBack: () => void }): JSX.Element {
	return (
		<section className="change-detail">
			<div className="change-detail-toolbar">
				<button type="button" className="change-back" onClick={onBack}>← 文件列表</button>
				<span className="change-detail-path">{file.relativePath}</span>
				<span className="change-file-stats"><em>+{file.additions}</em> <i>-{file.deletions}</i></span>
			</div>
			<div className="change-diff-grid">
				<DiffColumn title="修改前" content={file.before} tone="before" />
				<DiffColumn title="修改后" content={file.after} tone="after" />
			</div>
		</section>
	);
}

/**
 * Diff 单栏内容。
 * @param props 标题、文本与颜色语义。
 * @returns 单栏元素。
 */
function DiffColumn({ title, content, tone }: { title: string; content: string; tone: 'before' | 'after' }): JSX.Element {
	const lines = content ? content.split('\n') : [];
	return (
		<div className={`change-diff-column ${tone}`}>
			<div className="change-diff-title">{title}</div>
			{lines.length === 0 ? <div className="change-diff-empty">无内容</div> : (
				<pre>{lines.map((line, index) => <code key={index}><span>{index + 1}</span>{line || ' '}{'\n'}</code>)}</pre>
			)}
		</div>
	);
}

/**
 * 转换文件状态显示文本。
 * @param status 文件变更状态。
 * @returns 中文显示文本。
 */
function statusLabel(status: ChangeReviewFileDetail['status']): string {
	return status === 'added' ? '新增' : status === 'deleted' ? '删除' : '修改';
}
