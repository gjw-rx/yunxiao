/**
 * 代码变更查看页 - 展示一次最终回复关联的文件列表，并按需加载前后快照进行对照。
 */
import { Fragment, useEffect, useMemo, useState, type JSX } from 'react';
import { diffLines } from 'diff';
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
		<main className={`change-review-page${selected ? ' change-review-detail-page' : ''}`}>
			{selected ? <ChangeDetail file={selected} onBack={() => setSelected(undefined)} /> : (
				<>
					<header className="change-review-header">
						<div>
							<span className="change-review-kicker">本次回复</span>
							<h1>代码变更</h1>
						</div>
						<div className="change-review-total">{summary.fileCount} 个文件 <em>+{summary.additions}</em> <i>-{summary.deletions}</i></div>
					</header>
				<section className="change-file-list" aria-label="变更文件列表">
					{summary.files.map((file) => (
						<button key={file.id} type="button" className="change-file-row" onClick={() => post({ command: 'requestChangeReviewFile', fileId: file.id })}>
							<span className={`change-file-status ${file.status}`}>{statusLabel(file.status)}</span>
							<span className="change-file-path">{file.relativePath}</span>
							<span className="change-file-stats"><em>+{file.additions}</em> <i>-{file.deletions}</i></span>
						</button>
					))}
				</section>
				</>
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
	const rows = useMemo(() => buildDiffRows(file.before, file.after), [file.before, file.after]);
	const [name, directory] = splitFilePath(file.relativePath);
	return (
		<section className="change-detail">
			<div className="change-diff-tabbar">
				<button type="button" className="change-back" onClick={onBack} aria-label="返回文件列表">‹</button>
				<div className="change-diff-file-tab" data-testid="change-diff-file-tab">
					<span className="change-diff-file-icon" aria-hidden="true">◇</span>
					<span className="change-diff-file-name">{name}</span>
					{directory && <span className="change-diff-file-directory">{directory}</span>}
					<span className="change-file-stats"><em>+{file.additions}</em> <i>-{file.deletions}</i></span>
				</div>
			</div>
			<div
				className="change-diff"
				role="table"
				tabIndex={0}
				data-testid="change-diff-scroll-area"
				aria-label={`${file.relativePath} 的代码差异，可上下及左右滚动`}
			>
				<div className="change-diff-body" role="rowgroup">
					{rows.map((row, index) => row.kind === 'separator' ? (
						<div key={`separator-${index}`} className="change-diff-separator" role="row" data-testid="change-diff-hidden-lines">
							<HiddenLines count={row.hiddenLineCount} />
							<HiddenLines count={row.hiddenLineCount} />
						</div>
					) : (
						<DiffRow key={`row-${index}`} row={row} />
					))}
				</div>
			</div>
		</section>
	);
}

/**
 * 渲染两栏编辑器中一侧的折叠上下文提示。
 * @param props 被折叠的行数。
 * @returns 折叠行提示元素。
 */
function HiddenLines({ count }: { count: number }): JSX.Element {
	return <span className="change-diff-hidden-lines"><span aria-hidden="true">⌃</span>{count} 个隐藏的行</span>;
}

/**
 * 渲染一行并排差异。
 * @param props 差异行数据。
 * @returns 差异行元素。
 */
function DiffRow({ row }: { row: ContentDiffRow }): JSX.Element {
	const changed = row.kind === 'changed';
	return (
		<div className={`change-diff-row ${row.kind}`} role="row" data-testid="change-diff-row">
			<DiffCell
				lineNumber={row.beforeLine}
				content={row.before}
				kind={row.kind === 'added' ? 'empty' : row.kind === 'context' ? 'context' : 'removed'}
				highlight={changed}
				compareTo={row.after}
				testId={row.kind === 'context' ? 'change-diff-row-context' : row.kind === 'changed' || row.kind === 'removed' ? 'change-diff-row-removed' : undefined}
			/>
			<DiffCell
				lineNumber={row.afterLine}
				content={row.after}
				kind={row.kind === 'removed' ? 'empty' : row.kind === 'context' ? 'context' : 'added'}
				highlight={changed}
				compareTo={row.before}
				testId={row.kind === 'changed' || row.kind === 'added' ? 'change-diff-row-added' : undefined}
			/>
		</div>
	);
}

/** 差异单元格属性。 */
interface DiffCellProps {
	/** 行号。 */
	readonly lineNumber?: number;
	/** 当前侧的代码文本。 */
	readonly content?: string;
	/** 单元格变更类型。 */
	readonly kind: 'context' | 'removed' | 'added' | 'empty';
	/** 是否标记字符级改动。 */
	readonly highlight: boolean;
	/** 对侧代码文本。 */
	readonly compareTo?: string;
	/** 用于测试的稳定标识。 */
	readonly testId?: string;
}

/**
 * 渲染差异行的一侧代码与行号。
 * @param props 单元格显示数据。
 * @returns 单元格元素。
 */
function DiffCell({ lineNumber, content, kind, highlight, compareTo, testId }: DiffCellProps): JSX.Element {
	return (
		<div className={`change-diff-cell ${kind}`} data-testid={testId} role="cell">
			<span className="change-diff-line-number">{lineNumber ?? ''}</span>
			<code className="change-diff-code">
				{content === undefined ? '' : highlight ? renderChangedText(content, compareTo ?? '') : content || ' '}
			</code>
		</div>
	);
}

/** 差异内容行类型。 */
type DiffRowKind = 'context' | 'removed' | 'added' | 'changed';

/** 一行可见的差异内容。 */
interface ContentDiffRow {
	/** 行的变更类型。 */
	readonly kind: DiffRowKind;
	/** 修改前行号。 */
	readonly beforeLine?: number;
	/** 修改后行号。 */
	readonly afterLine?: number;
	/** 修改前代码。 */
	readonly before?: string;
	/** 修改后代码。 */
	readonly after?: string;
}

/** 省略未修改内容的分隔行。 */
interface SeparatorDiffRow {
	/** 分隔行标识。 */
	readonly kind: 'separator';
	/** 被折叠的未修改行数。 */
	readonly hiddenLineCount: number;
}

/** 可供页面渲染的差异行。 */
type VisibleDiffRow = ContentDiffRow | SeparatorDiffRow;

/**
 * 将两个文件快照转换为 Git 风格的、逐行对齐的差异行。
 * @param before 修改前文本。
 * @param after 修改后文本。
 * @returns 保留有限上下文的差异行。
 */
function buildDiffRows(before: string, after: string): readonly VisibleDiffRow[] {
	const rows: ContentDiffRow[] = [];
	let beforeLine = 1;
	let afterLine = 1;
	const changes = diffLines(before, after);
	for (let index = 0; index < changes.length; index += 1) {
		const change = changes[index];
		const lines = splitDiffLines(change.value);
		if (change.removed && changes[index + 1]?.added) {
			const addedLines = splitDiffLines(changes[index + 1].value);
			const count = Math.max(lines.length, addedLines.length);
			for (let lineIndex = 0; lineIndex < count; lineIndex += 1) {
				const removed = lines[lineIndex];
				const added = addedLines[lineIndex];
				rows.push(removed !== undefined && added !== undefined
					? { kind: 'changed', beforeLine: beforeLine++, afterLine: afterLine++, before: removed, after: added }
					: removed !== undefined
						? { kind: 'removed', beforeLine: beforeLine++, before: removed }
						: { kind: 'added', afterLine: afterLine++, after: added });
			}
			index += 1;
			continue;
		}
		for (const line of lines) {
			if (change.removed) {
				rows.push({ kind: 'removed', beforeLine: beforeLine++, before: line });
			} else if (change.added) {
				rows.push({ kind: 'added', afterLine: afterLine++, after: line });
			} else {
				rows.push({ kind: 'context', beforeLine: beforeLine++, afterLine: afterLine++, before: line, after: line });
			}
		}
	}
	return collapseUnchangedRows(rows);
}

/**
 * 将 diff 包返回的文本块拆分为代码行，避免末尾换行产生一行伪空内容。
 * @param value diff 文本块。
 * @returns 单独的代码行。
 */
function splitDiffLines(value: string): readonly string[] {
	if (!value) {
		return [];
	}
	const lines = value.split('\n');
	if (value.endsWith('\n')) {
		lines.pop();
	}
	return lines;
}

/**
 * 折叠过长的连续未修改行，仅保留变更附近各三行上下文。
 * @param rows 未折叠的差异行。
 * @returns 适合阅读的差异行。
 */
function collapseUnchangedRows(rows: readonly ContentDiffRow[]): readonly VisibleDiffRow[] {
	const result: VisibleDiffRow[] = [];
	for (let index = 0; index < rows.length;) {
		if (rows[index].kind !== 'context') {
			result.push(rows[index++]);
			continue;
		}
		const start = index;
		while (index < rows.length && rows[index].kind === 'context') {
			index += 1;
		}
		const group = rows.slice(start, index);
		if (group.length <= 6) {
			result.push(...group);
		} else {
			result.push(...group.slice(0, 3), { kind: 'separator', hiddenLineCount: group.length - 6 }, ...group.slice(-3));
		}
	}
	return result;
}

/**
 * 分离相对路径中的文件名与目录，供编辑器标签栏展示。
 * @param relativePath 工作区相对路径。
 * @returns 文件名与可选目录名。
 */
function splitFilePath(relativePath: string): readonly [string, string] {
	const segments = relativePath.split('/');
	return [segments.at(-1) ?? relativePath, segments.slice(0, -1).join('/')];
}

/**
 * 在被替换的两行中标记实际发生变化的字符范围。
 * @param value 当前侧代码文本。
 * @param compareTo 对侧代码文本。
 * @returns 带字符级高亮的 React 节点。
 */
function renderChangedText(value: string, compareTo: string): JSX.Element {
	let prefixLength = 0;
	while (prefixLength < value.length && prefixLength < compareTo.length && value[prefixLength] === compareTo[prefixLength]) {
		prefixLength += 1;
	}
	let suffixLength = 0;
	while (
		suffixLength < value.length - prefixLength &&
		suffixLength < compareTo.length - prefixLength &&
		value[value.length - suffixLength - 1] === compareTo[compareTo.length - suffixLength - 1]
	) {
		suffixLength += 1;
	}
	const changed = value.slice(prefixLength, value.length - suffixLength || undefined);
	return (
		<Fragment>
			{value.slice(0, prefixLength)}
			{changed ? <mark className="change-diff-line-highlight">{changed}</mark> : ' '}
			{suffixLength > 0 ? value.slice(-suffixLength) : ''}
		</Fragment>
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
