/**
 * Web 搜索契约 - Provider 接口、标准化请求/响应与错误类型。
 * Provider 实现（Tavily）与工具（web.search）通过本文件解耦：
 * 工具只依赖接口，外部响应格式变化不影响工具契约。
 */

/** Tavily 搜索深度。 */
export type WebSearchDepth = 'basic' | 'advanced';

/** Web 搜索请求（由工具根据配置与调用参数装配后交给 Provider）。 */
export interface WebSearchRequest {
	/** 搜索查询词（非空）。 */
	readonly query: string;
	/** Tavily API Key（仅用于构建请求，不出现在结果与错误中）。 */
	readonly apiKey: string;
	/** 返回结果数上限（1-10）。 */
	readonly maxResults: number;
	/** 搜索深度。 */
	readonly searchDepth: WebSearchDepth;
	/** 仅在这些域名内搜索（空数组 = 不限）。 */
	readonly includeDomains: readonly string[];
	/** 排除这些域名（空数组 = 不排除）。 */
	readonly excludeDomains: readonly string[];
	/** 请求超时（毫秒）。 */
	readonly timeoutMs: number;
}

/** 归一化的单条搜索结果（仅允许字段，含可引用 URL）。 */
export interface WebSearchResult {
	/** 结果标题。 */
	readonly title: string;
	/** 结果 URL。 */
	readonly url: string;
	/** 结果摘要。 */
	readonly snippet: string;
	/** 相关性评分（Provider 提供时存在）。 */
	readonly score?: number;
	/** 发布时间（Provider 提供时存在）。 */
	readonly publishedAt?: string;
}

/** 成功搜索响应（已归一化，不含 Provider 原始响应字段）。 */
export interface WebSearchResponse {
	/** 实际使用的查询词。 */
	readonly query: string;
	/** Provider 标识（如 "tavily"）。 */
	readonly provider: string;
	/** 搜索结果（按相关性排序）。 */
	readonly results: readonly WebSearchResult[];
}

/** Web 搜索 Provider 接口。 */
export interface WebSearchProvider {
	/**
	 * 执行一次网络搜索，返回归一化结果。
	 * @param request 搜索请求（含凭据与参数）
	 * @returns 归一化后的搜索结果
	 * @throws WebSearchError 认证失败/限流/超时/网络失败/无效响应（消息不含凭据）
	 */
	search(request: WebSearchRequest): Promise<WebSearchResponse>;
}

/** Web 搜索失败错误：携带是否可重试标记，消息为通用文案、不含任何凭据。 */
export class WebSearchError extends Error {
	/** 是否可由 Agent 在调整策略后有限重试。 */
	readonly retryable: boolean;

	/**
	 * @param message 无敏感信息的错误消息
	 * @param retryable 是否可重试（认证/配置错误 false，限流/超时/网络失败 true）
	 */
	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = 'WebSearchError';
		this.retryable = retryable;
	}
}

/** webSearch 未启用或缺少 API Key 时的固定错误消息（工具直接返回，不发起网络请求）。 */
export const WEB_SEARCH_UNAVAILABLE_MESSAGE =
	'webSearch 不可用：请配置 yunxiaoAgent.webSearch.enabled 与 yunxiaoAgent.webSearch.apiKey';
