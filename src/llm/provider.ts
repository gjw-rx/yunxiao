/**
 * Provider 工厂 - 根据配置创建 LLM Provider 实例。
 *
 * 迁移期 runtime 开关（config.runtime）：
 * - 默认 ai-sdk：创建 AISDKProvider（Vercel AI SDK 6.x，按 provider 分派 OpenAI-compatible 或 Anthropic 原生 Messages）
 * - legacy：仅 provider=openai 支持，显式回退到 OpenAIProvider（手写 fetch + SSE parser）
 */
import type { LLMProvider } from './types';
import type { ModelConfig } from '../config/modelConfig';
import { OpenAIProvider } from './openaiProvider';
import { AISDKProvider } from './aiSdkProvider';
import * as logger from '../logger';

/** 已支持的 Provider ID 集合。 */
const SUPPORTED_PROVIDER_IDS: ReadonlySet<string> = new Set(['openai', 'anthropic']);

/**
 * 创建 LLM Provider 实例。
 * 目前支持 "openai"（兼容 OpenAI/DeepSeek/通义千问等）与 "anthropic"（原生 Messages API，仅 ai-sdk runtime）。
 */
export function createProvider(config: ModelConfig): LLMProvider {
	const runtime = config.runtime ?? 'ai-sdk';
	logger.log(`[LLMProvider] 创建 Provider provider=${config.provider} model=${config.model} runtime=${runtime}`);
	if (!SUPPORTED_PROVIDER_IDS.has(config.provider)) {
		throw new Error(`不支持的 Provider: ${config.provider}（目前仅支持 "openai"、"anthropic"）`);
	}
	if (config.provider === 'anthropic') {
		if (runtime === 'legacy') {
			logger.error(`[LLMProvider] 拒绝创建 Provider：Anthropic 不支持 legacy 运行时 model=${config.model}`);
			throw new Error('Anthropic 模型仅支持 ai-sdk 运行时，不支持 legacy 手写 OpenAI 运行时');
		}
		return new AISDKProvider(config);
	}
	return runtime === 'legacy' ? new OpenAIProvider(config) : new AISDKProvider(config);
}

