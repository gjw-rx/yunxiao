/**
 * TavilyWebSearchProvider - 通过 Tavily 搜索 API 提供外部网络检索。
 * 使用全局 fetch + AbortController 实现超时控制；不记录凭据、请求头或完整认证响应，
 * 错误仅返回通用中文文案（不含 API Key），供 web_search 工具按现有失败协议转为结构化错误。
 */
import * as logger from '../../logger';
import {
	WebSearchError,
	type WebSearchProvider,
	type WebSearchRequest,
	type WebSearchResponse,
	type WebSearchResult,
} from './types';

/** Tavily 搜索 API 端点。 */
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

/** Tavily 原始响应（仅取需要的字段，其余丢弃）。 */
interface TavilyRawResponse {
	readonly results?: readonly unknown[];
}

/** Tavily 原始结果条目（字段名来自 Tavily API）。 */
interface TavilyRawResult {
	readonly title?: unknown;
	readonly url?: unknown;
	readonly content?: unknown;
	readonly score?: unknown;
	readonly published_date?: unknown;
}

/** Tavily Provider：将 Tavily 响应归一化为允许字段，失败抛无敏感信息的 WebSearchError。 */
export class TavilyWebSearchProvider implements WebSearchProvider {
	/**
	 * 执行一次 Tavily 搜索。
	 * @param request 搜索请求（含 query、apiKey 与参数）
	 * @returns 归一化后的搜索结果
	 * @throws WebSearchError 认证失败/限流/超时/网络失败/无效响应（消息不含凭据）
	 */
	async search(request: WebSearchRequest): Promise<WebSearchResponse> {
		const startedAt = Date.now();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), request.timeoutMs);

		let response: Response;
		try {
			response = await fetch(TAVILY_SEARCH_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${request.apiKey}`,
				},
				body: JSON.stringify(buildTavilyBody(request)),
				signal: controller.signal,
			});
		} catch (err) {
			clearTimeout(timer);
			if (err instanceof Error && err.name === 'AbortError') {
				logger.log(`[TavilyWebSearch] 搜索超时 duration=${Date.now() - startedAt}ms`);
				throw new WebSearchError(`Tavily 搜索超时（${request.timeoutMs}ms），请稍后重试`, true);
			}
			logger.log(`[TavilyWebSearch] 网络请求失败 duration=${Date.now() - startedAt}ms`);
			throw new WebSearchError('Tavily 网络请求失败，请稍后重试', true);
		}
		clearTimeout(timer);

		// 非成功状态：按状态码类别分类，日志仅记录状态码与耗时
		if (!response.ok) {
			logger.log(
				`[TavilyWebSearch] HTTP ${response.status}（${Math.floor(response.status / 100)}xx） duration=${Date.now() - startedAt}ms`
			);
			if (response.status === 401 || response.status === 403) {
				throw new WebSearchError('Tavily 认证失败：请检查 yunxiaoAgent.webSearch.apiKey', false);
			}
			if (response.status === 429) {
				throw new WebSearchError('Tavily 请求过于频繁（限流），请稍后重试', true);
			}
			if (response.status >= 500) {
				throw new WebSearchError(`Tavily 服务错误（HTTP ${response.status}），请稍后重试`, true);
			}
			throw new WebSearchError(`Tavily 请求失败（HTTP ${response.status}）`, false);
		}

		let data: unknown;
		try {
			data = await response.json();
		} catch {
			logger.error('[TavilyWebSearch] 响应 JSON 解析失败');
			throw new WebSearchError('Tavily 返回了无效响应', false);
		}

		const results = normalizeResults(data);
		logger.log(`[TavilyWebSearch] 搜索成功 results=${results.length} duration=${Date.now() - startedAt}ms`);
		return {
			query: request.query,
			provider: 'tavily',
			results,
		};
	}
}

/**
 * 构造 Tavily 请求体（空域名列表不传对应字段，交由服务端默认行为）。
 * @param request 搜索请求
 * @returns Tavily API 请求体
 */
function buildTavilyBody(request: WebSearchRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		query: request.query,
		max_results: request.maxResults,
		search_depth: request.searchDepth,
	};
	if (request.includeDomains.length > 0) {
		body.include_domains = [...request.includeDomains];
	}
	if (request.excludeDomains.length > 0) {
		body.exclude_domains = [...request.excludeDomains];
	}
	return body;
}

/**
 * 校验并归一化 Tavily 响应：仅保留 title/url/content/score/published_date 对应字段，
 * 丢弃其余原始字段；结构不合法时视为无效响应。
 * @param data 已解析的 Tavily 响应 JSON
 * @returns 归一化结果列表
 * @throws WebSearchError 响应结构不合法（不可重试）
 */
function normalizeResults(data: unknown): WebSearchResult[] {
	const raw = data as TavilyRawResponse;
	if (typeof data !== 'object' || data === null || !Array.isArray(raw.results)) {
		logger.error('[TavilyWebSearch] 响应缺少 results 数组，视为无效响应');
		throw new WebSearchError('Tavily 返回了无效响应', false);
	}
	const results: WebSearchResult[] = [];
	for (const item of raw.results) {
		const result = normalizeResult(item);
		if (result) {
			results.push(result);
		}
	}
	return results;
}

/**
 * 归一化单条结果：仅取 title/url/content/score/published_date 五个允许字段，
 * 字段缺失或类型不符时丢弃该条结果。
 * @param item Tavily 原始结果条目
 * @returns 归一化结果；无法归一化时返回 undefined
 */
function normalizeResult(item: unknown): WebSearchResult | undefined {
	if (typeof item !== 'object' || item === null) {
		return undefined;
	}
	const raw = item as TavilyRawResult;
	if (typeof raw.title !== 'string' || typeof raw.url !== 'string') {
		return undefined;
	}
	return {
		title: raw.title,
		url: raw.url,
		snippet: typeof raw.content === 'string' ? raw.content : '',
		...(typeof raw.score === 'number' ? { score: raw.score } : {}),
		...(typeof raw.published_date === 'string' ? { publishedAt: raw.published_date } : {}),
	};
}
