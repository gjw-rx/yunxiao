/**
 * 模型配置管理 - 从 VSCode 配置读取模型连接参数。
 */
import * as vscode from 'vscode';
import * as logger from '../logger';

/**
 * 模型运行时选择（迁移期临时开关）。
 * - `ai-sdk`：默认，使用 Vercel AI SDK 6.x 模型协议层
 * - `legacy`：回退到手写 OpenAI fetch + SSE parser
 */
export type ModelRuntime = 'ai-sdk' | 'legacy';

/** 模型配置 */
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

const CONFIG_SECTION = 'yunxiaoAgent.model';

const DEFAULTS: ModelConfig = {
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

/** 从 VSCode 配置读取模型设置 */
export function getModelConfig(): ModelConfig {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const modelConfig: ModelConfig = {
		provider: config.get<string>('provider', DEFAULTS.provider),
		model: config.get<string>('model', DEFAULTS.model),
		apiKey: config.get<string>('apiKey', DEFAULTS.apiKey),
		baseURL: config.get<string>('baseURL', DEFAULTS.baseURL),
		temperature: config.get<number>('temperature', DEFAULTS.temperature),
		maxTokens: config.get<number>('maxTokens', DEFAULTS.maxTokens),
		runtime: normalizeRuntime(config.get<unknown>('runtime')),
	};
	logger.log(`[ModelConfig] 读取配置完成 provider=${modelConfig.provider} model=${modelConfig.model || '(未配置)'} apiKey=${modelConfig.apiKey ? '已配置' : '未配置'} runtime=${modelConfig.runtime}`);
	return modelConfig;
}

/**
 * 监听模型配置变更，返回可释放的订阅。
 * 仅当 `yunxiaoAgent.model.*` 配置变化时触发回调。
 */
export function onModelConfigChange(callback: (config: ModelConfig) => void): vscode.Disposable {
	return vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration(CONFIG_SECTION)) {
			callback(getModelConfig());
		}
	});
}
