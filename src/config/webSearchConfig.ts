/**
 * Web 搜索配置管理 - 从 VSCode 配置读取 Tavily 外部检索参数。
 * 配置项集中在 `yunxiaoAgent.webSearch.*`；插件不内置或生成 API Key，
 * 未配置时 webSearch 不可用（工具返回明确错误，不发起网络请求）。
 */
import * as vscode from 'vscode';
import * as logger from '../logger';
import type { WebSearchDepth } from '../tools/web/types';

/** Web 搜索配置（来自 yunxiaoAgent.webSearch.*）。 */
export interface WebSearchConfig {
	/** 是否启用外部网络检索。 */
	readonly enabled: boolean;
	/** Tavily API Key（用户自行配置，默认空字符串）。 */
	readonly apiKey: string;
	/** 默认结果数（1-10，调用参数缺省时使用）。 */
	readonly maxResults: number;
	/** 搜索深度（basic/advanced）。 */
	readonly searchDepth: WebSearchDepth;
	/** Tavily 请求超时（毫秒）。 */
	readonly timeoutMs: number;
	/** 仅在这些域名内搜索（空数组 = 不限）。 */
	readonly includeDomains: readonly string[];
	/** 排除这些域名（空数组 = 不排除）。 */
	readonly excludeDomains: readonly string[];
}

/** 配置节前缀。 */
const CONFIG_SECTION = 'yunxiaoAgent.webSearch';

/** maxResults 支持范围下限。 */
export const MAX_RESULTS_MIN = 1;
/** maxResults 支持范围上限。 */
export const MAX_RESULTS_MAX = 10;
/** timeoutMs 最小合法值（毫秒）。 */
const MIN_TIMEOUT_MS = 1_000;

/** 默认配置（不含 API Key）。 */
const DEFAULTS: WebSearchConfig = {
	enabled: false,
	apiKey: '',
	maxResults: 5,
	searchDepth: 'basic',
	timeoutMs: 15_000,
	includeDomains: [],
	excludeDomains: [],
};

/**
 * 从 VSCode 配置读取 Web 搜索配置，并对数值/枚举做边界约束（maxResults 收敛到 1-10，
 * searchDepth 非法值回退 basic，timeoutMs 低于下限或非法回退默认值）。
 * @returns 规范化后的 Web 搜索配置
 */
export function getWebSearchConfig(): WebSearchConfig {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const rawMax = config.get<number>('maxResults', DEFAULTS.maxResults);
	const rawTimeout = config.get<number>('timeoutMs', DEFAULTS.timeoutMs);
	const rawDepth = config.get<string>('searchDepth', DEFAULTS.searchDepth);
	const webSearchConfig: WebSearchConfig = {
		enabled: config.get<boolean>('enabled', DEFAULTS.enabled),
		apiKey: config.get<string>('apiKey', DEFAULTS.apiKey),
		maxResults: clampMaxResults(rawMax),
		searchDepth: rawDepth === 'advanced' ? 'advanced' : 'basic',
		timeoutMs:
			typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout >= MIN_TIMEOUT_MS
				? Math.floor(rawTimeout)
				: DEFAULTS.timeoutMs,
		includeDomains: config.get<string[]>('includeDomains', [...DEFAULTS.includeDomains]),
		excludeDomains: config.get<string[]>('excludeDomains', [...DEFAULTS.excludeDomains]),
	};
	logger.log(
		`[WebSearchConfig] 读取配置完成 enabled=${webSearchConfig.enabled} ` +
			`hasApiKey=${webSearchConfig.apiKey ? '已配置' : '未配置'} ` +
			`maxResults=${webSearchConfig.maxResults} searchDepth=${webSearchConfig.searchDepth} timeoutMs=${webSearchConfig.timeoutMs}`
	);
	return webSearchConfig;
}

/**
 * 将结果数约束到 1-10 支持范围（非法值回退默认 5）。
 * @param value 原始结果数
 * @returns 约束后的结果数
 */
export function clampMaxResults(value: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULTS.maxResults;
	}
	return Math.min(MAX_RESULTS_MAX, Math.max(MAX_RESULTS_MIN, Math.floor(value)));
}
