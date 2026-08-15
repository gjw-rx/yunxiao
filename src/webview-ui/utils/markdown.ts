/**
 * Markdown 渲染工具。
 *
 * 职责：将 `marked` 渲染能力迁移为 Webview bundle 内部依赖（替代原
 * `src/webview/marked.js` 全局脚本），保持与迁移前一致的安全渲染与文本
 * 转义行为（`marked.parse(text, { breaks: true })` + CSP 边界）。
 */
import { marked } from 'marked';

// 与迁移前全局 marked 行为保持一致：启用 GFM 换行（单换行视为 <br>）
marked.setOptions({ breaks: true });

/**
 * 将 Markdown 文本渲染为 HTML 字符串。
 * 用户内容经 marked 转义 + Webview CSP（default-src 'none'）双层边界，不信任原始 HTML。
 *
 * @param text Markdown 源文本
 * @returns 渲染后的 HTML
 */
export function renderMarkdown(text: string): string {
	return marked.parse(text, { async: false, breaks: true }) as string;
}
