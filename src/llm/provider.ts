/**
 * Provider 工厂 - 根据配置创建 LLM Provider 实例。
 *
 * 迁移期 runtime 开关（config.runtime）：
 * - 默认 ai-sdk：创建 AISDKProvider（Vercel AI SDK 6.x OpenAI-compatible）
 * - legacy：显式回退到 OpenAIProvider（手写 fetch + SSE parser）
 */
import type { LLMProvider } from './types';
import type { ModelConfig } from '../config/modelConfig';
import { OpenAIProvider } from './openaiProvider';
import { AISDKProvider } from './aiSdkProvider';
import * as logger from '../logger';

/**
 * 创建 LLM Provider 实例。
 * 目前支持 "openai"（兼容 OpenAI/DeepSeek/通义千问等）。
 */
export function createProvider(config: ModelConfig): LLMProvider {
	const runtime = config.runtime ?? 'ai-sdk';
	logger.log(`[LLMProvider] 创建 Provider provider=${config.provider} model=${config.model} runtime=${runtime}`);
	switch (config.provider) {
		case 'openai':
			return runtime === 'legacy' ? new OpenAIProvider(config) : new AISDKProvider(config);
		default:
			throw new Error(`不支持的 Provider: ${config.provider}（目前仅支持 "openai"）`);
	}
}
