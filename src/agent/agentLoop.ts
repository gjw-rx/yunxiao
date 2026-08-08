/**
 * Agent Loop - 本地 Agent 循环核心。
 *
 * 驱动 LLM 推理与工具调用的多轮交互：
 * 用户消息 -> LLM 响应 -> 工具调用 -> 续轮 -> 最终回复。
 *
 * 参考 opencode 双层循环设计，简化为单层 while + 工具续轮。
 */
import { randomUUID } from 'crypto';
import type { LLMProvider, LLMRequest, LLMMessage } from '../llm/types';
import type { MessageStore } from '../memory/messageStore';
import { loadHistoryForLLM } from '../memory/historyLoader';
import type { ToolRouter } from '../core/toolRouter';
import type { ToolRegistry } from '../core/toolRegistry';
import type { EventBus } from '../core/eventBus';
import type { ToolContext } from '../tools/baseTool';
import type { ToolResult } from '../core/types';
import type { SkillRegistry } from '../skill/skillRegistry';
import { toolSchemasToDefinitions, llmToolCallToCoreToolCall, toolResultToContent } from './toolAdapter';
import { buildSystemPrompt } from './systemPrompt';
import type { CompactionConfig } from './compaction';
import { compactIfNeeded } from './compaction';
import { ToolCallTracker } from './toolCallTracker';
import { ToolResultCache } from './toolResultCache';
import * as logger from '../logger';

/** AgentLoop 配置 */
export interface AgentLoopConfig {
	/** 模型名称 */
	readonly model: string;
	/** Provider ID（如 "openai"） */
	readonly providerId?: string;
	/** 温度参数 */
	readonly temperature: number;
	/** 最大输出 token 数 */
	readonly maxTokens: number;
	/** Agent Loop 最大步数（默认 50） */
	readonly maxSteps: number;
	/** 工作区根目录列表 */
	readonly workspaceRoots: string[];
	/** 读文件大小上限（字节） */
	readonly maxFileSize?: number;
	/** 工具执行超时（毫秒） */
	readonly toolTimeoutMs?: number;
	/** 终端输出截断上限（字符） */
	readonly terminalOutputLimit?: number;
	/** 工具结果文本截断上限（字符） */
	readonly toolResultLimit?: number;
	/** 自定义 Agent 系统提示词（覆盖默认） */
	readonly agentPrompt?: string;
	/** Skill 注册表（为 null 时系统提示词不含 Skill guidance） */
	readonly skillRegistry?: SkillRegistry | null;
	/** 上下文压缩配置（可选，不配置则不启用压缩） */
	readonly compaction?: CompactionConfig;
	/** 连续重复调用阈值（默认 3） */
	readonly repeatThreshold?: number;
	/** 是否缓存只读工具结果（默认 true） */
	readonly cacheReadTools?: boolean;
}

const MAX_STEPS_PROMPT =
	'You have reached the maximum number of steps. ' +
	'Please summarize what you have accomplished and what remains to be done.';

export class AgentLoop {
	private abortController: AbortController | null = null;

	constructor(
		private readonly provider: LLMProvider,
		private readonly messageStore: MessageStore,
		private readonly toolRouter: ToolRouter,
		private readonly toolRegistry: ToolRegistry,
		private readonly eventBus: EventBus,
		private readonly config: AgentLoopConfig,
	) {}

	/** 主循环入口：追加用户消息，进入 Agent Loop。 */
	async run(sessionId: string, userText: string): Promise<void> {
		this.abortController = new AbortController();
		const { signal } = this.abortController;

		this.messageStore.append(sessionId, { role: 'user', content: userText });
		this.emitRunStateChange(sessionId, 'running');
		logger.log(`[AgentLoop] run 开始 sessionId=${sessionId} 用户消息长度=${userText.length}`);

		let step = 0;
		const repeatThreshold = this.config.repeatThreshold ?? 3;
		const cacheReadTools = this.config.cacheReadTools ?? true;
		const callTracker = new ToolCallTracker();
		const resultCache = new ToolResultCache();
		let stepWarned = false;

		try {
			let overflowRetry = false;

		while (true) {
				if (signal.aborted) {
					logger.log('[AgentLoop] 循环中断: abort signal');
					break;
				}

				// 上下文压缩检查（每轮开始前）
				if (this.config.compaction?.enabled && !overflowRetry) {
					const allMessages = this.messageStore.loadHistory(sessionId);
					await compactIfNeeded(sessionId, allMessages, this.provider, this.config.model, this.config.compaction, this.messageStore, this.eventBus);
				}
				overflowRetry = false;

				// 加载历史
			const history = loadHistoryForLLM(sessionId, this.messageStore);

			// 构建系统提示词
			const systemPrompt = buildSystemPrompt({
				agentPrompt: this.config.agentPrompt,
				skills: this.config.skillRegistry?.list() ?? [],
				workspaceRoot: this.config.workspaceRoots[0] ?? '',
				platform: process.platform,
				date: new Date().toISOString().slice(0, 10),
				modelId: this.config.model,
				providerId: this.config.providerId,
			});

			// 构建消息：系统提示词 + 历史
			const messages: LLMMessage[] = [
				{ role: 'system', content: systemPrompt },
				...history,
			];

				// 物化工具定义
				const tools = toolSchemasToDefinitions(this.toolRegistry.list());

				// Max Steps 检查
			let toolChoice: 'auto' | 'none' = 'auto';
			if (step >= this.config.maxSteps) {
				toolChoice = 'none';
				messages.push({ role: 'user', content: MAX_STEPS_PROMPT });
			} else if (!stepWarned && step >= Math.floor(this.config.maxSteps * 0.8)) {
				stepWarned = true;
				const warning = `You are approaching the maximum step limit (${this.config.maxSteps} steps). You have used ${step} steps. Please wrap up your work.`;
				messages.push({ role: 'user', content: warning });
				this.messageStore.append(sessionId, { role: 'user', content: warning });
				logger.log(`[AgentLoop] step=${step} 接近 maxSteps=${this.config.maxSteps}，注入预警`);
			}

				// 构建 LLM 请求
				const request: LLMRequest = {
					model: this.config.model,
					messages,
					tools: toolChoice === 'none' ? undefined : tools,
					toolChoice,
					temperature: this.config.temperature,
					maxTokens: this.config.maxTokens,
					stream: true,
				};

				// 调用 LLM 并消费流式事件
				const eventStream = this.provider.chatCompletion(request);
				let textContent = '';
				const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
				let hasError = false;
				let errorMessage = '';
				logger.log(`[AgentLoop] step=${step} 调用 LLM model=${this.config.model} 消息数=${messages.length} tools=${tools?.length ?? 0} toolChoice=${toolChoice}`);

				for await (const event of eventStream) {
					if (signal.aborted) {
						break;
					}

					if (event.type === 'textDelta') {
						textContent += event.text;
						this.eventBus.emit({
							type: 'content',
							sessionId,
							payload: event.text,
						});
					} else if (event.type === 'toolCall') {
					const callId = event.id || randomUUID();
					pendingToolCalls.push({
						id: callId,
						name: event.name,
						arguments: event.arguments,
					});
					let parsedArgs: unknown;
					try {
						parsedArgs = JSON.parse(event.arguments);
					} catch {
						parsedArgs = {};
					}
					this.eventBus.emit({
						type: 'tool_call',
						sessionId,
						payload: { call_id: callId, tool: event.name, args: parsedArgs },
					});
				} else if (event.type === 'usage') {
						logger.log(`[AgentLoop] token 用量: input=${event.inputTokens} output=${event.outputTokens}`);
						this.eventBus.emit({
							type: 'token_usage',
							sessionId,
							payload: {
								token_usage: {
									prompt_tokens: event.inputTokens,
									completion_tokens: event.outputTokens,
									total_tokens: event.inputTokens + event.outputTokens,
								},
								input_length: history.length,
							},
						});
					} else if (event.type === 'finish') {
						break;
					} else if (event.type === 'error') {
						hasError = true;
						errorMessage = event.error;
						this.eventBus.emit({
						type: 'error',
						sessionId,
						payload: event.error,
					});
						break;
					}
				}

				// 处理中断
				if (signal.aborted) {
					logger.log('[AgentLoop] 用户中断，保存部分回复');
					this.messageStore.append(sessionId, {
						role: 'assistant',
						content: textContent,
					});
					this.emitRunStateChange(sessionId, 'cancelled');
					this.eventBus.emit({ type: 'stream_end', sessionId, payload: {} });
					return;
				}

				// 处理错误
				if (hasError) {
					logger.notifyError('[AgentLoop] LLM 返回错误', { step, errorMessage, sessionId });
					// Context overflow 恢复：assistant 尚未输出时触发压缩后重试
					const isOverflow = /context_length|maximum context|too many tokens|token limit/i.test(errorMessage);
					if (isOverflow && !textContent && this.config.compaction?.enabled) {
						logger.log('[AgentLoop] 检测到上下文溢出，尝试压缩后重试');
						const allMessages = this.messageStore.loadHistory(sessionId);
						const compacted = await compactIfNeeded(
							sessionId, allMessages, this.provider, this.config.model,
							this.config.compaction, this.messageStore, this.eventBus,
						);
						if (compacted) {
							overflowRetry = true;
							continue;
						}
					}
					this.emitRunStateChange(sessionId, 'failed', errorMessage);
					this.eventBus.emit({ type: 'stream_end', sessionId, payload: {} });
					return;
				}

				// 无工具调用 -> 循环结束
				if (pendingToolCalls.length === 0) {
					logger.log(`[AgentLoop] step=${step} 无工具调用，循环结束 文本长度=${textContent.length}`);
					this.messageStore.append(sessionId, {
						role: 'assistant',
						content: textContent,
					});
					break;
				}

				// 有工具调用 -> 追加 assistant 消息（含 toolCalls），执行工具，续轮
				logger.log(`[AgentLoop] step=${step} 收到 ${pendingToolCalls.length} 个工具调用: ${pendingToolCalls.map(tc => tc.name).join(', ')}`);
				this.messageStore.append(sessionId, {
					role: 'assistant',
					content: textContent,
					toolCalls: pendingToolCalls.map((tc) => ({
						id: tc.id,
						name: tc.name,
						arguments: tc.arguments,
					})),
				});

				const toolContext = this.buildToolContext(sessionId);

				// 串行执行工具
			for (const tc of pendingToolCalls) {
				if (signal.aborted) {
					break;
				}

				const coreCall = llmToolCallToCoreToolCall(tc);
				const isReadTool = this.isReadTool(tc.name);

				// P0: 重复调用检测（在缓存检查之前，确保重复计数不受缓存影响）
				const repeatCount = callTracker.check(tc.name, coreCall.args);
				if (repeatCount >= repeatThreshold) {
					logger.log(`[AgentLoop] 工具 ${tc.name} 连续重复 ${repeatCount} 次，注入引导消息`);
					callTracker.reset();
					this.messageStore.append(sessionId, {
						role: 'user',
						content: `You are repeatedly calling ${tc.name} with the same arguments. This suggests you may be stuck. Please try a different approach or summarize what you have accomplished.`,
					});
					continue;
				}

				// P5: 缓存检查（只读工具 + cacheReadTools 启用）
				if (cacheReadTools && isReadTool && resultCache.has(tc.name, coreCall.args)) {
					const cached = resultCache.get(tc.name, coreCall.args)!;
					const cachedResult: ToolResult = {
						...cached,
						call_id: tc.id,
						result: `[cached] ${cached.result ?? ''}`,
					};
					logger.log(`[AgentLoop] 工具 ${tc.name} 缓存命中，跳过执行`);
					this.eventBus.emit({
						type: 'tool_state_change',
						sessionId,
						payload: { call_id: tc.id, tool: tc.name, state: 'success', args: coreCall.args },
					});
					this.eventBus.emit({
						type: 'tool_result',
						sessionId,
						payload: cachedResult,
					});
					this.messageStore.append(sessionId, {
						role: 'tool',
						toolCallId: tc.id,
						content: toolResultToContent(cachedResult),
					});
					continue;
				}

				this.eventBus.emit({
				type: 'tool_state_change',
				sessionId,
				payload: { call_id: tc.id, tool: tc.name, state: 'running', args: coreCall.args },
			});

				let result: ToolResult;
				try {
					result = await this.toolRouter.route(coreCall, toolContext);
					logger.log(`[AgentLoop] 工具 ${tc.name} 执行完成 status=${result.status}`);
				} catch (error) {
					logger.notifyError(`[AgentLoop] 工具 ${tc.name} 执行异常`, error instanceof Error ? error.message : String(error));
					result = {
						call_id: tc.id,
						status: 'error',
						error: error instanceof Error ? error.message : String(error),
					};
				}

				// P5: 缓存只读工具的成功结果
				if (cacheReadTools && isReadTool && result.status === 'success') {
					resultCache.set(tc.name, coreCall.args, result);
				}

				this.eventBus.emit({
					type: 'tool_state_change',
					sessionId,
					payload: {
						call_id: tc.id,
						tool: tc.name,
						state: result.status,
						error: result.error,
						output: result.result,
					},
				});

					this.eventBus.emit({
						type: 'tool_result',
						sessionId,
						payload: result,
					});

					this.messageStore.append(sessionId, {
						role: 'tool',
						toolCallId: tc.id,
						content: toolResultToContent(result),
					});
				}

				// 工具执行后检查中断
			if (signal.aborted) {
				this.emitRunStateChange(sessionId, 'cancelled');
				this.eventBus.emit({ type: 'stream_end', sessionId, payload: {} });
				return;
			}

			// P1: 工具执行后额外检查 compaction
			if (this.config.compaction?.enabled) {
				const postToolMessages = this.messageStore.loadHistory(sessionId);
				await compactIfNeeded(sessionId, postToolMessages, this.provider, this.config.model, this.config.compaction, this.messageStore, this.eventBus);
			}

			step++;
			}

			// 正常完成
			this.emitRunStateChange(sessionId, 'completed');
			this.eventBus.emit({ type: 'stream_end', sessionId, payload: {} });
			logger.log(`[AgentLoop] 正常完成 sessionId=${sessionId} 共 ${step} 步`);
		} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.notifyError('[AgentLoop] 未捕获异常', { sessionId, msg });
		this.eventBus.emit({
			type: 'error',
			sessionId,
			payload: msg,
		});
			this.emitRunStateChange(sessionId, 'failed', msg);
			this.eventBus.emit({ type: 'stream_end', sessionId, payload: {} });
		}
	}

	/** 中断当前正在执行的 Agent Loop。 */
	cancel(): void {
		this.abortController?.abort();
	}

	/** 判断工具是否为只读（用于缓存决策）。 */
	private isReadTool(name: string): boolean {
		try {
			return this.toolRegistry.lookup(name).permission === 'read';
		} catch {
			return false;
		}
	}

	/** 构建 ToolContext，注入运行时信息。 */
	private buildToolContext(sessionId: string): ToolContext {
		return {
			workspaceRoots: this.config.workspaceRoots,
			maxFileSize: this.config.maxFileSize,
			toolTimeoutMs: this.config.toolTimeoutMs,
			sessionId,
			terminalOutputLimit: this.config.terminalOutputLimit,
			abortSignal: this.abortController?.signal,
			toolResultLimit: this.config.toolResultLimit,
		};
	}

	/** 发出 run_state_change 事件。 */
	private emitRunStateChange(
		sessionId: string,
		state: 'running' | 'completed' | 'cancelled' | 'failed',
		error?: string,
	): void {
		this.eventBus.emit({
			type: 'run_state_change',
			sessionId,
			payload: {
				generation: 0,
				state,
				...(error ? { error } : {}),
			},
		});
	}
}
