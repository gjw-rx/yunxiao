/**
 * Markdown 渲染组件。
 *
 * 职责：将助手消息文本渲染为 Markdown HTML（经 marked 转义 + CSP 边界），
 * 保持迁移前的安全渲染与文本转义行为。
 */
import { useMemo, type JSX } from 'react';
import { renderMarkdown } from '../../utils/markdown';

/** Markdown 渲染组件属性。 */
export interface MarkdownProps {
	/** Markdown 源文本 */
	text: string;
}

/** 将文本渲染为 Markdown。 */
export function Markdown({ text }: MarkdownProps): JSX.Element {
	const html = useMemo(() => renderMarkdown(text || ''), [text]);
	return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
