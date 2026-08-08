/**
 * Provider 工厂 - 根据配置创建 LLM Provider 实例。
 */
import type { LLMProvider } from './types';
import type { ModelConfig } from '../config/modelConfig';
import { OpenAIProvider } from './openaiProvider';

/**
 * 创建 LLM Provider 实例。
 * 目前支持 "openai"（兼容 OpenAI/DeepSeek/通义千问等）。
 */
export function createProvider(config: ModelConfig): LLMProvider {
	switch (config.provider) {
		case 'openai':
			return new OpenAIProvider(config);
		default:
			throw new Error(`不支持的 Provider: ${config.provider}（目前仅支持 "openai"）`);
	}
}
