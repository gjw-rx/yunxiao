/**
 * AI SDK Model Factory - 将现有 ModelConfig 映射为 AI SDK 语言模型（按 provider 显式分派）。
 *
 * 职责：
 * 1. 按 provider 分派：`anthropic` 走 createAnthropic（原生 Messages API）；
 *    其余 OpenAI-compatible 生态（openai/deepseek 等）统一走 createOpenAICompatible（沿用既有行为不变）。
 * 2. 生成参数（temperature / maxTokens / reasoningEffort）不在此处固化，
 *    由 AISDKProvider 在每次 streamText 调用时传入（Provider-specific 选项留在 runtime）。
 * 3. 打包 AI SDK 工具定义：将 LLM 层 ToolDefinition（名称 + 描述 + JSON Schema 参数）
 *    转为 AI SDK tool() 定义，且绝不注册 execute 回调——本地工具执行只允许经 ToolRouter。
 */
import { createOpenAICompatible, type OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { tool, jsonSchema, type LanguageModel, type Tool } from 'ai';
import type { ToolDefinition } from './types';
import * as logger from '../logger';

/** OpenAI-compatible Provider 的 providerOptions 键名（与 createOpenAICompatible 的 name 保持一致） */
export const OPENAI_COMPATIBLE_PROVIDER_KEY = 'openai-compatible';

/** Anthropic Provider 的 providerOptions 键名（与 @ai-sdk/anthropic 固定使用的 key 一致） */
export const ANTHROPIC_PROVIDER_KEY = 'anthropic';

/**
 * 创建 AI SDK 语言模型实例：按 provider 显式分派。
 * - `anthropic`：走 createAnthropic（原生 Messages API）；其余 OpenAI-compatible 生态（含 deepseek 等）
 *   统一走 createOpenAICompatible（保持既有行为不变）。
 *
 * @param config 模型配置（provider / apiKey / baseURL / model）
 * @returns 可直接用于 streamText 的 LanguageModel
 * @throws provider 为显式未知值（既非 anthropic 也非法）时在创建阶段拒绝，不发起网络请求
 */
export function createAiSdkModel(config: {
	readonly provider: string;
	readonly apiKey: string;
	readonly baseURL: string;
	readonly model: string;
}): LanguageModel {
	if (config.provider === 'anthropic') {
		logger.log(`[AiSdkModelFactory] 创建 Anthropic 原生 Messages 模型 model=${config.model} baseURL=${config.baseURL}`);
		const provider = createAnthropic({
			baseURL: config.baseURL.replace(/\/+$/, ''),
			apiKey: config.apiKey || undefined,
		});
		return provider(config.model);
	}
	// 其余一律视为 OpenAI-compatible（openai / deepseek / 自定义代理等），沿用既有逻辑不变
	const provider: OpenAICompatibleProvider = createOpenAICompatible({
		name: OPENAI_COMPATIBLE_PROVIDER_KEY,
		// 去掉 baseURL 尾部斜杠（与 legacy OpenAIProvider 行为一致）
		baseURL: config.baseURL.replace(/\/+$/, ''),
		apiKey: config.apiKey || undefined,
		// 流式响应中携带 usage，供 token 记账使用
		includeUsage: true,
	});
	return provider(config.model);
}

/**
 * 将 LLM 层 ToolDefinition[] 转换为 AI SDK 工具定义表。
 *
 * 安全约束：只提供 description + inputSchema（注册的 JSON Schema），
 * 禁止为本地工具注册 execute / onInputAvailable 等执行回调，
 * 确保本地工具执行仍只经 AgentLoop → ToolRouter 路径。
 *
 * @param tools 已注册工具的定义列表
 * @returns AI SDK streamText 可接受的 tools 表（name → Tool）
 */
export function toAiSdkTools(tools: readonly ToolDefinition[]): Record<string, Tool> {
	const result: Record<string, Tool> = {};
	for (const t of tools) {
		result[t.name] = tool({
			description: t.description,
			inputSchema: jsonSchema(t.parameters),
		});
	}
	return result;
}
