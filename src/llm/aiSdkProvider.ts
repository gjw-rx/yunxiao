/**
 * AI SDK Provider - 以 Vercel AI SDK 6.x 实现 LLMProvider 接口。
 *
 * 职责：
 * 1. 将 LLMRequest 映射为 streamText 输入（model / messages / tools / toolChoice / 生成参数）。
 * 2. 消费 fullStream，经 aiSdkStreamAdapter 归一化为 LLMEvent 序列。
 * 3. 透传 AgentLoop abort signal 到 AI SDK，真正取消 provider 请求。
 * 4. 处理网络错误、provider warning 与取消，关键分支用项目 logger 输出中文可定位日志。
 *
 * Provider-specific 选项（reasoning / DeepSeek thinking / Anthropic effort 与 prompt cache）
 * 全部隔离在本层，按 provider key 分别构造，AgentLoop 不感知任何 provider 细节。
 */
import { streamText, type JSONValue, type ModelMessage } from 'ai';
import type { LLMProvider, LLMRequest, LLMEvent, ReasoningEffort } from './types';
import type { ModelConfig } from '../config/modelConfig';
import { createAiSdkModel, toAiSdkTools, OPENAI_COMPATIBLE_PROVIDER_KEY, ANTHROPIC_PROVIDER_KEY } from './aiSdkModelFactory';
import { convertToModelMessages } from './aiSdkMessageConverter';
import { mapStreamPart } from './aiSdkStreamAdapter';
import * as logger from '../logger';

export class AISDKProvider implements LLMProvider {
	constructor(private readonly config: ModelConfig) { }

	async *chatCompletion(request: LLMRequest): AsyncGenerator<LLMEvent> {
		const model = createAiSdkModel(this.config);
		const messages = convertToModelMessages(request.messages);
		if (this.config.provider === 'anthropic') {
			applyAnthropicCacheBreakpoint(messages);
		}
		const tools = request.tools ? toAiSdkTools(request.tools) : undefined;
		const reasoning = buildAiSdkReasoningParams(
			request.reasoningEffort,
			this.config.provider,
			this.config.baseURL,
		);

		logger.log(
			`# [AISDKProvider] 调用模型 — provider=${this.config.provider} model=${request.model} messages=${request.messages.length} tools=${tools ? Object.keys(tools).length : 0} toolChoice=${request.toolChoice ?? 'auto'} reasoningEffort=${request.reasoningEffort ?? 'default'} deepseekThinking=${reasoning.deepseekThinking}`,
		);

		let result: ReturnType<typeof streamText>;
		try {
			result = streamText({
				model,
				messages,
				tools,
				toolChoice: request.toolChoice ?? 'auto',
				temperature: reasoning.omitTemperature ? undefined : request.temperature,
				maxOutputTokens: request.maxTokens,
				abortSignal: request.abortSignal,
				providerOptions: reasoning.providerOptions,
				// 不启用 AI SDK telemetry，项目日志与审计是默认可观测性来源
				experimental_telemetry: undefined,
				maxRetries: 0,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.notifyError('# [AISDKProvider] streamText 同步构造失败', { error: msg, model: request.model });
			yield { type: 'error', error: `模型调用失败: ${msg}` };
			return;
		}

		// 流式消费：仅最终 finish 的 totalUsage 作为权威 usage，每次调用最多发一次
		const state: { usageEmitted: boolean } = { usageEmitted: false };
		try {
			for await (const part of result.fullStream) {
				if (request.abortSignal?.aborted) {
					logger.log(`# [AISDKProvider] 收到 abort signal，停止消费流 — model=${request.model}`);
					break;
				}
				// start-step 携带 provider warning：记录但不阻断
				if (part.type === 'start-step' && part.warnings.length > 0) {
					for (const w of part.warnings) {
						const feature = 'feature' in w ? String((w as { feature?: unknown }).feature) : 'other';
						const message = 'message' in w ? String((w as { message?: unknown }).message) : '';
						logger.log(`# [AISDKProvider] provider warning — model=${request.model} feature=${feature} message=${message}`);
					}
				}
				for (const event of mapStreamPart(part, state)) {
					if (event.type === 'usage') {
						logger.log(
							`# [AISDKProvider] 权威 usage — input=${event.inputTokens} output=${event.outputTokens} total=${event.totalTokens ?? 'n/a'} reasoning=${event.reasoningTokens ?? 'n/a'} cacheRead=${event.cacheReadTokens ?? 'n/a'} cacheWrite=${event.cacheWriteTokens ?? 'n/a'} noCache=${event.noCacheTokens ?? 'n/a'}`,
						);
					}
					yield event;
				}
			}
		} catch (err) {
			if (request.abortSignal?.aborted) {
				logger.log(`# [AISDKProvider] 流被取消，忽略下游异常 — model=${request.model}`);
				return;
			}
			const msg = err instanceof Error ? err.message : String(err);
			logger.notifyError('# [AISDKProvider] 流式调用失败', { error: msg, model: request.model });
			yield { type: 'error', error: `模型调用失败: ${msg}` };
		}
	}
}

/**
 * AI SDK 生成参数中的 reasoning 映射结果。
 */
interface ReasoningParams {
	/** 传给 streamText 的 providerOptions（keyed by OPENAI_COMPATIBLE_PROVIDER_KEY） */
	readonly providerOptions?: Record<string, Record<string, JSONValue>>;
	/** DeepSeek 思考模式下 temperature 仅支持 1.0，需省略该字段 */
	readonly omitTemperature: boolean;
	/** 是否为 DeepSeek 思考模式（用于日志） */
	readonly deepseekThinking: boolean;
}

/**
 * 按既有 buildReasoningParams 的语义构造 AI SDK reasoning 参数，按 provider key 隔离：
 * - Anthropic：`low/medium/high` 原样映射为 providerOptions.anthropic.effort；未设置时不发送该字段，
 *   保留模型默认行为；内部旧档位（minimal/disabled）无原生等价时省略并记录诊断。
 * - DeepSeek（provider 或 baseURL 命中 deepseek）：默认 thinking.enabled，显式档位附 reasoning_effort（minimal→low），disabled 发 thinking.disabled。
 * - 其他 OpenAI-compatible 后端：仅显式档位（非 disabled）传 reasoning_effort。
 *
 * @param effort 思维链强度（可能未设置）
 * @param providerId Provider ID
 * @param baseURL API 地址
 */
function buildAiSdkReasoningParams(
	effort: ReasoningEffort | undefined,
	providerId: string,
	baseURL: string,
): ReasoningParams {
	if (providerId === 'anthropic') {
		return buildAnthropicReasoningParams(effort);
	}

	const isDeepSeek =
		providerId.toLowerCase().includes('deepseek') || baseURL.toLowerCase().includes('deepseek.com');

	// DeepSeek：未设置时默认开启思考
	if (isDeepSeek) {
		if (effort === undefined) {
			return {
				providerOptions: { [OPENAI_COMPATIBLE_PROVIDER_KEY]: { thinking: { type: 'enabled' } } },
				omitTemperature: true,
				deepseekThinking: true,
			};
		}
		if (effort === 'disabled') {
			return {
				providerOptions: { [OPENAI_COMPATIBLE_PROVIDER_KEY]: { thinking: { type: 'disabled' } } },
				omitTemperature: false,
				deepseekThinking: false,
			};
		}
		// DeepSeek 无 minimal 档，映射为最弱档 low
		const mapped = effort === 'minimal' ? 'low' : effort;
		return {
			providerOptions: {
				[OPENAI_COMPATIBLE_PROVIDER_KEY]: {
					thinking: { type: 'enabled' },
					reasoningEffort: mapped,
				},
			},
			omitTemperature: true,
			deepseekThinking: true,
		};
	}

	// 其他 OpenAI-compatible 后端：仅显式档位（非 disabled）传 reasoning_effort
	if (effort && effort !== 'disabled') {
		return {
			providerOptions: { [OPENAI_COMPATIBLE_PROVIDER_KEY]: { reasoningEffort: effort } },
			omitTemperature: false,
			deepseekThinking: false,
		};
	}
	return { omitTemperature: false, deepseekThinking: false };
}

/** Anthropic 原生 effort 支持的三档（与设置页 ReasoningLevel 一致）。 */
const ANTHROPIC_NATIVE_EFFORT_LEVELS: ReadonlySet<ReasoningEffort> = new Set(['low', 'medium', 'high']);

/**
 * 构造 Anthropic 的 reasoning 参数：直接把 low/medium/high 映射为原生 effort。
 * 未设置档位或内部旧档位（minimal/disabled）无原生等价时不发送 effort，
 * 并在后一种情况记录诊断日志，避免伪造等价档位。
 *
 * @param effort 思维链强度（可能未设置）
 */
function buildAnthropicReasoningParams(effort: ReasoningEffort | undefined): ReasoningParams {
	if (effort === undefined) {
		return { omitTemperature: false, deepseekThinking: false };
	}
	if (ANTHROPIC_NATIVE_EFFORT_LEVELS.has(effort)) {
		return {
			providerOptions: { [ANTHROPIC_PROVIDER_KEY]: { effort } },
			omitTemperature: false,
			deepseekThinking: false,
		};
	}
	logger.log(`[AISDKProvider] Anthropic 无 ${effort} 档位的原生等价，省略 effort 参数`);
	return { omitTemperature: false, deepseekThinking: false };
}

/**
 * 仅对 Anthropic 请求在最后一个可缓存内容块注入 5 分钟 ephemeral cache breakpoint（design.md Decision 6）。
 * 直接修改传入数组最后一条消息的 providerOptions（该消息对象是本次请求专属的转换结果，不是持久化数据，
 * 不会写回会话存储或下发 Webview）。空消息列表时不做任何事。
 *
 * @param messages 已转换的 AI SDK 消息列表（原地修改最后一条）
 */
function applyAnthropicCacheBreakpoint(messages: ModelMessage[]): void {
	if (messages.length === 0) {
		return;
	}
	const last = messages[messages.length - 1];
	last.providerOptions = {
		...last.providerOptions,
		[ANTHROPIC_PROVIDER_KEY]: {
			...last.providerOptions?.[ANTHROPIC_PROVIDER_KEY],
			cacheControl: { type: 'ephemeral' },
		},
	};
}
