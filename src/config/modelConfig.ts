/**
 * 模型配置类型与默认值 - 定义模型连接参数的共享契约。
 *
 * 配置的读取、保存与校验由 `modelConfigStore.ts`（插件私有存储：globalState + SecretStorage）承担，
 * 本文件不再从 VS Code 配置 API 读取 `yunxiaoAgent.model.*`。
 */
import * as logger from '../logger';

/**
 * 模型运行时选择（迁移期临时开关）。
 * - `ai-sdk`：默认，使用 Vercel AI SDK 6.x 模型协议层
 * - `legacy`：回退到手写 OpenAI fetch + SSE parser
 */
export type ModelRuntime = 'ai-sdk' | 'legacy';

/** 模型配置（含 API Key，仅扩展宿主内部持有，不回传 Webview） */
export interface ModelConfig {
	/** Provider ID（如 "openai"） */
	readonly provider: string;
	/** 模型名称（如 "gpt-4o-mini"） */
	readonly model: string;
	/** API Key */
	readonly apiKey: string;
	/** API 地址 */
	readonly baseURL: string;
	/** 温度参数 */
	readonly temperature: number;
	/** 最大输出 token 数 */
	readonly maxTokens: number;
	/** 模型运行时选择（迁移期开关，缺省为 ai-sdk） */
	readonly runtime?: ModelRuntime;
}

/** 模型配置安全默认值（无已保存配置时使用，供存储服务合并）。 */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
	provider: 'openai',
	model: '',
	apiKey: '',
	baseURL: 'https://api.openai.com/v1',
	temperature: 0.7,
	maxTokens: 4096,
	runtime: 'ai-sdk',
};

/** 合法 runtime 取值集合 */
const VALID_RUNTIMES: ReadonlySet<string> = new Set(['ai-sdk', 'legacy']);

/**
 * 解析 runtime 配置值：仅接受 'ai-sdk' | 'legacy'，非法值降级为默认 'ai-sdk'。
 * 导出供测试直接调用（避免依赖 VS Code config API）。
 * @param raw 原始配置值
 * @returns 归一化后的 ModelRuntime
 */
export function normalizeRuntime(raw: unknown): ModelRuntime {
	if (typeof raw === 'string' && VALID_RUNTIMES.has(raw)) {
		return raw as ModelRuntime;
	}
	// 非法值兜底为默认 ai-sdk，避免扩展因配置错误无法加载
	if (raw !== undefined) {
		logger.log(`[ModelConfig] model.runtime 配置值非法 raw=${String(raw)}，降级为默认 ai-sdk`);
	}
	return 'ai-sdk';
}
