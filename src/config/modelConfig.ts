/**
 * 模型配置管理 - 从 VSCode 配置读取模型连接参数。
 */
import * as vscode from 'vscode';
import * as logger from '../logger';

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
}

const CONFIG_SECTION = 'yunxiaoAgent.model';

const DEFAULTS: ModelConfig = {
	provider: 'openai',
	model: '',
	apiKey: '',
	baseURL: 'https://api.openai.com/v1',
	temperature: 0.7,
	maxTokens: 4096,
};

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
	};
	logger.log(`[ModelConfig] 读取配置完成 provider=${modelConfig.provider} model=${modelConfig.model || '(未配置)'} apiKey=${modelConfig.apiKey ? '已配置' : '未配置'}`);
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
