/**
 * Agent Loop - 本地 Agent 循环核心。
 *
 * 参照 opencode prompt.ts runLoop 设计改造：
 * - 每轮重新加载完整历史（确保模型看到完整上下文）
 * - 工具始终执行（无缓存机制）
 * - doom loop 检测替代重复检测
 * - 检查 assistant.finish 判断循环退出（而非仅检查 pendingToolCalls.length）
 * - 上下文溢出时自动压缩重试
 */
import type { LLMProvider, LLMRequest, LLMMessage, LLMEvent, ReasoningEffort } from '../llm/types';
import type { MessageStore } from '../memory/messageStore';
import { loadHistoryForLLM } from '../memory/historyLoader';
import type { ToolRouter } from '../core/toolRouter';
import type { ToolRegistry } from '../core/toolRegistry';
import type { EventBus } from '../core/eventBus';
import type { ToolContext } from '../tools/baseTool';
import type { ToolResult, ToolCall } from '../core/types';
import type { SkillRegistry } from '../skill/skillRegistry';
import { toolSchemasToDefinitions, llmToolCallToCoreToolCall, toolResultToContent } from './toolAdapter';
import { buildSystemPrompt } from './systemPrompt';
import { loadProjectRules } from './projectRules';
import { loadTraeRules } from './traeRules';
import type { SyncSource } from '../config/syncConfig';
import type { CompactionConfig } from './compaction';
import { compactIfNeeded } from './compaction';
import { estimateText, estimateRequest } from './tokenEstimator';
import type { TokenUsageSnapshot } from '../memory/types';
import { randomUUID } from 'crypto';
import { DoomLoopDetector } from './doomLoopDetector';
import { ToolValidationError } from '../core/errors';
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
	/** 读文件分页：单页最大行数（默认 2000）。 */
	readonly readMaxLines?: number;
	/** 读文件分页：累计字节预算（默认 50KB，受 maxFileSize 护栏约束）。 */
	readonly readMaxBytes?: number;
	/** 读文件分页：单行最大字符数（默认 2000）。 */
	readonly readMaxLineLength?: number;
	/** 结果治理：最大行数（默认 2000）。 */
	readonly governMaxLines?: number;
	/** 结果治理：最大字节数（默认 50KB）。 */
	readonly governMaxBytes?: number;
	/** 工具执行超时（毫秒） */
	readonly toolTimeoutMs?: number;
	/** 终端输出截断上限（字符） */
	readonly terminalOutputLimit?: number;
	/** 工具结果文本截断上限（字符） */
	readonly toolResultLimit?: number;
	/** 自定义 Agent 系统提示词（覆盖默认） */
	readonly agentPrompt?: string;
	/** 思维链强度（缺省由 Provider 决定：DeepSeek 默认开启思考，其余不强制） */
	readonly reasoningEffort?: ReasoningEffort;
	/** Skill 注册表（为 null 时系统提示词不含 Skill guidance） */
	readonly skillRegistry?: SkillRegistry | null;
	/** 上下文压缩配置（可选，不配置则不启用压缩） */
	readonly compaction?: CompactionConfig;
	/** 配置来源读取函数（none/claude/trae 三选一）：决定项目规则注入哪一套（CLAUDE.md 或 .trae/rules），由扩展装配时注入 */
	readonly syncSource?: () => SyncSource;
}

const MAX_STEPS_PROMPT =
	'You have reached the maximum number of steps. ' +
	'Please summarize what you have accomplished and what remains to be done.';

const DOOM_LOOP_GUIDANCE_PREFIX =
	'You are repeatedly calling the same tool with the same arguments. ' +
	'This suggests you may be stuck in a loop. ' +
	'Stop re-collecting information you already have. ' +
	'Review the conversation history and proceed with the actual task';

/** 模型回复正文为空（无文本、无工具调用）时注入的提示，要求其直接给出最终答案。 */
const EMPTY_REPLY_PROMPT =
	'Your previous response was empty (no text, no tool calls). ' +
	'Please provide your final answer now, based on the information already gathered. ' +
	'If the task cannot be completed, clearly explain what is blocking you and what you need from the user.';

/** 空回复兜底的最大重试次数（达到后即使仍为空也正常结束）。 */
const MAX_EMPTY_REPLY_RETRIES = 2;

/** 同一轮中只读可并行工具的最大并发数（参照 langchain maxConcurrency / Anthropic 并行 tool use 建议）。 */
const MAX_PARALLEL_TOOLS = 3;

export class AgentLoop {
	private abortController: AbortController | null = null;

	constructor(
		private readonly provider: LLMProvider,
		private readonly messageStore: MessageStore,
		private readonly toolRouter: ToolRouter,
		private readonly toolRegistry: ToolRegistry,
		private readonly eventBus: EventBus,
		private readonly config: AgentLoopConfig,
	) { }

	/** 主循环入口：追加用户消息，进入 Agent Loop。 */
	async run(sessionId: string, userText: string): Promise<void> {
		this.abortController = new AbortController();
		const { signal } = this.abortController;

		const userMessage = this.messageStore.append(sessionId, { role: 'user', content: userText });
		const userMsgSeq = userMessage.seq;
		// run 开始前会话累计（用于 delta 计算）
		const baseTotal = this.aggregateSessionTokens(sessionId);
		this.emitRunStateChange(sessionId, 'running');
		logger.log(`[AgentLoop] run 开始 sessionId=${sessionId} 用户消息长度=${userText.length}`);

		const doomDetector = new DoomLoopDetector();
		// 本次 run 的唯一执行范围 ID（toolExecutionJournal 用 runId+callId 隔离回执）
		const runId = randomUUID();
		let step = 0;
		let stepWarned = false;
		let emptyReplyRetries = 0;

		try {
			while (true) {
				if (signal.aborted) {
					logger.log('[AgentLoop] 循环中断: abort signal');
					break;
				}

				// ── 1. 上下文压缩检查（每轮开始前）──
				if (this.config.compaction?.enabled) {
					const allMessages = this.messageStore.loadHistory(sessionId);
					await compactIfNeeded(
						sessionId, allMessages, this.provider, this.config.model,
						this.config.compaction, this.messageStore, this.eventBus,
					);
				}

				// ── 2. 加载完整历史（每轮重新加载，确保模型看到完整上下文）──
				const history = loadHistoryForLLM(sessionId, this.messageStore);

				// ── 3. 构建系统提示词（每轮重读项目规范，保证使用最新内容）──
				// 配置来源二选一：claude 注入 CLAUDE.md/AGENTS.md 项目规范，trae 注入 .trae/rules 规则，none 均不注入，避免两套约束重复
				const syncSource = this.config.syncSource?.() ?? 'none';
				const workspaceRoot = this.config.workspaceRoots[0] ?? '';
				const systemPrompt = buildSystemPrompt({
					agentPrompt: this.config.agentPrompt,
					skills: this.config.skillRegistry?.list() ?? [],
					workspaceRoot,
					platform: process.platform,
					date: new Date().toISOString().slice(0, 10),
					modelId: this.config.model,
					providerId: this.config.providerId,
					projectRules: syncSource === 'claude' ? await loadProjectRules(workspaceRoot) : null,
					traeRules: syncSource === 'trae' ? await loadTraeRules(workspaceRoot) : null,
				});

				// ── 4. 组装消息 ──
				const messages: LLMMessage[] = [
					{ role: 'system', content: systemPrompt },
					...history,
				];

				// ── 5. Max Steps 检查 ──
				let toolChoice: 'auto' | 'none' = 'auto';
				if (step >= this.config.maxSteps) {
					toolChoice = 'none';
					messages.push({ role: 'user', content: MAX_STEPS_PROMPT });
				} else if (!stepWarned && step >= Math.floor(this.config.maxSteps * 0.8)) {
					stepWarned = true;
					const warning = `You are approaching the maximum step limit (${this.config.maxSteps} steps). You have used ${step} steps. Please wrap up your work and provide your final answer.`;
					messages.push({ role: 'user', content: warning });
					this.messageStore.append(sessionId, { role: 'user', content: warning });
					logger.log(`[AgentLoop] step=${step} 接近 maxSteps=${this.config.maxSteps}，注入预警`);
				}

				// ── 6. 物化工具定义 ──
				const tools = toolSchemasToDefinitions(this.toolRegistry.list());

				// ── 7. 构建 LLM 请求并调用 ──
				const request: LLMRequest = {
					model: this.config.model,
					messages,
					tools: toolChoice === 'none' ? undefined : tools,
					toolChoice,
					temperature: this.config.temperature,
					maxTokens: this.config.maxTokens,
					reasoningEffort: this.config.reasoningEffort,
					stream: true,
					// 将取消信号透传给 AI SDK runtime，真正取消 provider 请求
					abortSignal: signal,
				};

				logger.log(`[AgentLoop] step=${step} 调用 LLM model=${this.config.model} 消息数=${messages.length} tools=${tools?.length ?? 0} toolChoice=${toolChoice}`);

				// ── 8. 消费流式事件 ──
				const streamResult = await this.consumeStream(
					this.provider.chatCompletion(request),
					sessionId,
					signal,
				);

				// ── 8.5 每步 token 记账：组装四类拆分，回写用户消息分摊值 ──
				const tokenSnapshot = this.buildTokenSnapshot({
					request,
					systemPrompt,
					streamResult,
					userText,
				});
				if (tokenSnapshot) {
					this.messageStore.updateMessage(sessionId, userMsgSeq, {
						inputTokens: tokenSnapshot.user_input,
					});
				}
				// usage 缺失时补发 token_usage 事件（估算 input_length），供前端显示
				if (!streamResult.usage) {
					const inputLength = estimateRequest(systemPrompt, messages, tools);
					this.eventBus.emit({
						type: 'token_usage',
						sessionId,
						payload: {
							token_usage: {
								prompt_tokens: inputLength,
								completion_tokens: streamResult.textContent ? estimateText(streamResult.textContent) : 0,
								total_tokens: inputLength + (streamResult.textContent ? estimateText(streamResult.textContent) : 0),
							},
							input_length: inputLength,
							source: 'estimated',
						},
					});
				}

				// 每步 LLM 输出结束：前端对该步文本做 markdown 终渲染，恢复回合边界
				if (streamResult.textContent) {
					this.eventBus.emit({ type: 'step_end', sessionId, payload: {} });
				}

				// 处理中断
				if (signal.aborted) {
					logger.log('[AgentLoop] 用户中断，保存部分回复');
					this.messageStore.append(sessionId, {
						role: 'assistant',
						content: streamResult.textContent,
						tokenUsage: tokenSnapshot ?? undefined,
					});
					this.emitRunStateChange(sessionId, 'cancelled');
					this.eventBus.emit({ type: 'stream_end', sessionId, payload: {} });
					return;
				}

				// 处理错误
				if (streamResult.hasError) {
					logger.notifyError('[AgentLoop] LLM 返回错误', { step, errorMessage: streamResult.errorMessage, sessionId });
					// Context overflow 恢复
					const isOverflow = /context_length|maximum context|too many tokens|token limit/i.test(streamResult.errorMessage);
					if (isOverflow && !streamResult.textContent && this.config.compaction?.enabled) {
						logger.log('[AgentLoop] 检测到上下文溢出，尝试压缩后重试');
						const allMessages = this.messageStore.loadHistory(sessionId);
						const compacted = await compactIfNeeded(
							sessionId, allMessages, this.provider, this.config.model,
							this.config.compaction, this.messageStore, this.eventBus,
						);
						if (compacted) {
							continue;
						}
					}
					this.emitRunStateChange(sessionId, 'failed', streamResult.errorMessage);
					this.eventBus.emit({ type: 'stream_end', sessionId, payload: {} });
					return;
				}

				// ── 9. 判断循环退出条件（参照 opencode: finish && !tool-calls）──
				const hasToolCalls = streamResult.pendingToolCalls.length > 0;
				const finishReason = streamResult.finishReason;

				if (!hasToolCalls || (finishReason && finishReason !== 'tool_use' && finishReason !== 'length')) {
					// 空回复兜底：确实无工具调用、正文为空且非错误/长度截断时，注入提示要求模型直接给最终答案后重试
					const text = streamResult.textContent;
					if (
						!hasToolCalls &&
						!text.trim() &&
						!streamResult.hasError &&
						finishReason !== 'length' &&
						emptyReplyRetries < MAX_EMPTY_REPLY_RETRIES
					) {
						emptyReplyRetries++;
						logger.log(`[AgentLoop] step=${step} 空回复，注入提示后重试 ${emptyReplyRetries}/${MAX_EMPTY_REPLY_RETRIES} finish=${finishReason}`);
						this.messageStore.append(sessionId, { role: 'assistant', content: text, tokenUsage: tokenSnapshot ?? undefined });
						this.messageStore.append(sessionId, { role: 'user', content: EMPTY_REPLY_PROMPT });
						step++;
						continue;
					}
					// 无工具调用，或 LLM 明确表示完成 → 保存 assistant 消息，退出循环
					logger.log(`[AgentLoop] step=${step} 循环结束 文本长度=${text.length} finish=${finishReason} tools=${hasToolCalls}`);
					this.messageStore.append(sessionId, {
						role: 'assistant',
						content: text,
						tokenUsage: tokenSnapshot ?? undefined,
					});
					break;
				}

				// ── 10. 有工具调用 → 追加 assistant 消息，执行工具 ──
				logger.log(`[AgentLoop] step=${step} 收到 ${streamResult.pendingToolCalls.length} 个工具调用: ${streamResult.pendingToolCalls.map(tc => tc.name).join(', ')}`);
				this.messageStore.append(sessionId, {
					role: 'assistant',
					content: streamResult.textContent,
					toolCalls: streamResult.pendingToolCalls.map((tc) => ({
						id: tc.id,
						name: tc.name,
						arguments: tc.arguments,
					})),
					tokenUsage: tokenSnapshot ?? undefined,
				});

				const toolContext = this.buildToolContext(sessionId, runId);

				// ── 11. 执行工具：只读+canParallel 最多 3 并发，写/执行串行，结果按模型返回顺序入库 ──
				const { blocked } = await this.executeToolCalls(
					streamResult.pendingToolCalls,
					toolContext,
					doomDetector,
					sessionId,
					userText,
				);

				// 工具执行后检查中断
				if (signal.aborted) {
					this.emitRunStateChange(sessionId, 'cancelled');
					this.eventBus.emit({ type: 'stream_end', sessionId, payload: {} });
					return;
				}

				// 如果被 doom loop 阻断，跳过 compaction 检查直接进入下一轮
				if (blocked) {
					step++;
					continue;
				}

				// ── 12. 工具执行后额外检查 compaction ──
				if (this.config.compaction?.enabled) {
					const postToolMessages = this.messageStore.loadHistory(sessionId);
					await compactIfNeeded(
						sessionId, postToolMessages, this.provider, this.config.model,
						this.config.compaction, this.messageStore, this.eventBus,
					);
				}

				step++;
			}

			// 正常完成
			this.emitSessionTokenUsage(sessionId, baseTotal);
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
			this.emitSessionTokenUsage(sessionId, baseTotal);
			this.emitRunStateChange(sessionId, 'failed', msg);
			this.eventBus.emit({ type: 'stream_end', sessionId, payload: {} });
		}
	}

	/** 中断当前正在执行的 Agent Loop。 */
	cancel(): void {
		this.abortController?.abort();
	}

	/** 构建 ToolContext，注入运行时信息。 */
	private buildToolContext(sessionId: string, runId: string): ToolContext {
		return {
			workspaceRoots: this.config.workspaceRoots,
			maxFileSize: this.config.maxFileSize,
			readMaxLines: this.config.readMaxLines,
			readMaxBytes: this.config.readMaxBytes,
			readMaxLineLength: this.config.readMaxLineLength,
			governMaxLines: this.config.governMaxLines,
			governMaxBytes: this.config.governMaxBytes,
			toolTimeoutMs: this.config.toolTimeoutMs,
			sessionId,
			runId,
			terminalOutputLimit: this.config.terminalOutputLimit,
			abortSignal: this.abortController?.signal,
			toolResultLimit: this.config.toolResultLimit,
		};
	}

	/**
	 * 执行本轮工具调用（参照 langchain maxConcurrency / Anthropic 并行 tool use 实践）。
	 * - doom loop 检测提前到调度前：命中后注入引导，该调用及其后的调用不再执行
	 * - 只读+canParallel 工具最多 MAX_PARALLEL_TOOLS 个并发，写/执行/destructive 串行
	 * - 结果按模型返回顺序写入 messageStore，保证 OpenAI 兼容 API 的 tool 消息配对稳定
	 */
	private async executeToolCalls(
		pendingToolCalls: Array<{ id: string; name: string; arguments: string }>,
		toolContext: ToolContext,
		doomDetector: DoomLoopDetector,
		sessionId: string,
		userText: string,
	): Promise<{ blocked: boolean }> {
		// 1. 调度前 doom 扫描：找到第一个触发 doom loop 的调用，其后的调用不再执行
		let doomIndex = -1;
		for (let i = 0; i < pendingToolCalls.length; i++) {
			if (doomDetector.check(pendingToolCalls[i]).isDoom) {
				doomIndex = i;
				doomDetector.reset();
				break;
			}
		}

		let blocked = false;
		const schedulable = pendingToolCalls.slice(0, doomIndex === -1 ? pendingToolCalls.length : doomIndex);
		if (doomIndex !== -1) {
			blocked = true;
			const doomTool = pendingToolCalls[doomIndex].name;
			logger.log(`[AgentLoop] doom loop 检测到: ${doomTool} 连续重复，注入引导消息`);
			const guidance = `${DOOM_LOOP_GUIDANCE_PREFIX}. You have repeatedly called ${doomTool} ${3} times with identical arguments. Stop and review the conversation history - you already have this information. Proceed with the user's original task: ${userText}`;
			this.messageStore.append(sessionId, {
				role: 'user',
				content: guidance,
			});
		}

		// 2. 分组：只读+canParallel 进并行组，其余进串行组
		const parallel: Array<{ coreCall: ToolCall; index: number }> = [];
		const serial: Array<{ coreCall: ToolCall; index: number }> = [];
		schedulable.forEach((tc, index) => {
			const coreCall = llmToolCallToCoreToolCall(tc);
			(this.toolRouter.canRunInParallel(coreCall) ? parallel : serial).push({ coreCall, index });
		});

		// 3. 执行：并行组有界并发，串行组逐个；结果按原索引写入
		const results: Array<ToolResult | undefined> = new Array(schedulable.length);
		await this.runBoundedParallel(parallel, results, toolContext, sessionId);
		for (const item of serial) {
			if (this.abortController?.signal.aborted) {
				break;
			}
			results[item.index] = await this.executeSingleTool(item.coreCall, toolContext, sessionId);
		}

		// 4. 按模型返回顺序写入 tool 消息（被 doom 跳过的调用不写）
		for (const result of results) {
			if (result) {
				this.messageStore.append(sessionId, {
					role: 'tool',
					toolCallId: result.call_id,
					content: toolResultToContent(result),
				});
			}
		}

		return { blocked };
	}

	/**
	 * 有界并发执行并行组：固定 MAX_PARALLEL_TOOLS 个 worker 消费任务队列，
	 * 结果按原索引写入（顺序稳定）。abort 后不再启动新调用，已启动的调用跑完。
	 */
	private async runBoundedParallel(
		items: Array<{ coreCall: ToolCall; index: number }>,
		results: Array<ToolResult | undefined>,
		toolContext: ToolContext,
		sessionId: string,
	): Promise<void> {
		const signal = this.abortController?.signal;
		let next = 0;
		const workerCount = Math.min(MAX_PARALLEL_TOOLS, items.length);
		await Promise.all(
			Array.from({ length: workerCount }, async () => {
				while (next < items.length) {
					if (signal?.aborted) {
						return;
					}
					const item = items[next++];
					results[item.index] = await this.executeSingleTool(item.coreCall, toolContext, sessionId);
				}
			}),
		);
	}

	/** 执行单个工具并发出状态/结果事件（并行与串行共用同一状态机）。 */
	private async executeSingleTool(
		coreCall: ToolCall,
		toolContext: ToolContext,
		sessionId: string,
	): Promise<ToolResult> {
		this.eventBus.emit({
			type: 'tool_state_change',
			sessionId,
			payload: { call_id: coreCall.call_id, tool: coreCall.tool, state: 'running', args: coreCall.args },
		});

		let result: ToolResult;
		try {
			result = await this.toolRouter.route(coreCall, toolContext);
			logger.log(`[AgentLoop] 工具 ${coreCall.tool} 执行完成 status=${result.status}`);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (error instanceof ToolValidationError) {
				// 模型传参错误：属可预期的业务错误，不记 ERROR 弹窗，作为普通工具错误返回由模型自行修正
				logger.log(`[AgentLoop] 工具 ${coreCall.tool} 参数校验失败: ${errorMsg}`);
			} else {
				logger.notifyError(`[AgentLoop] 工具 ${coreCall.tool} 执行异常`, errorMsg);
			}
			result = {
				call_id: coreCall.call_id,
				status: 'error',
				error: errorMsg,
			};
		}

		this.eventBus.emit({
			type: 'tool_state_change',
			sessionId,
			payload: {
				call_id: coreCall.call_id,
				tool: coreCall.tool,
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

		return result;
	}

	/** 消费 LLM 流式事件，返回累积结果。 */
	private async consumeStream(
		eventStream: AsyncGenerator<LLMEvent>,
		sessionId: string,
		signal: AbortSignal,
	): Promise<{
		textContent: string;
		pendingToolCalls: Array<{ id: string; name: string; arguments: string }>;
		hasError: boolean;
		errorMessage: string;
		finishReason: string | null;
		/** 累积的思考（reasoning）增量文本，用于缺失 reasoning_tokens 时估算 */
		reasoningText: string;
		/** provider 报告的 usage（最后一次 usage 事件），缺失时为 undefined */
		usage: {
			inputTokens: number;
			outputTokens: number;
			reasoningTokens?: number;
			totalTokens?: number;
			cacheReadTokens?: number;
			cacheWriteTokens?: number;
		} | null;
	}> {
		let textContent = '';
		let reasoningText = '';
		const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
		let hasError = false;
		let errorMessage = '';
		let finishReason: string | null = null;
		let usage: {
			inputTokens: number;
			outputTokens: number;
			reasoningTokens?: number;
			totalTokens?: number;
			cacheReadTokens?: number;
			cacheWriteTokens?: number;
		} | null = null;

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
			} else if (event.type === 'reasoningDelta') {
				// 思维链增量：与正文分离，转发给 UI 的 thought 展示通道
				reasoningText += event.text;
				this.eventBus.emit({
					type: 'thought',
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
				usage = {
					inputTokens: event.inputTokens,
					outputTokens: event.outputTokens,
					...(event.reasoningTokens !== undefined ? { reasoningTokens: event.reasoningTokens } : {}),
					...(event.totalTokens !== undefined ? { totalTokens: event.totalTokens } : {}),
					...(event.cacheReadTokens !== undefined ? { cacheReadTokens: event.cacheReadTokens } : {}),
					...(event.cacheWriteTokens !== undefined ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
				};
				logger.log(`[AgentLoop] token 用量: input=${event.inputTokens} output=${event.outputTokens} reasoning=${event.reasoningTokens ?? 'n/a'}`);
				this.eventBus.emit({
					type: 'token_usage',
					sessionId,
					payload: {
						token_usage: {
							prompt_tokens: event.inputTokens,
							completion_tokens: event.outputTokens,
							total_tokens: event.totalTokens ?? event.inputTokens + event.outputTokens,
							...(event.reasoningTokens !== undefined ? { reasoning_tokens: event.reasoningTokens } : {}),
							...(event.cacheReadTokens !== undefined ? { cache_read_tokens: event.cacheReadTokens } : {}),
							...(event.cacheWriteTokens !== undefined ? { cache_write_tokens: event.cacheWriteTokens } : {}),
						},
						// 真实 prompt token 数（provider 报告），不再硬编码 0
						input_length: event.inputTokens,
						source: 'usage',
					},
				});
			} else if (event.type === 'finish') {
				// 记录结束原因但不中断：provider 常在 finish 之后的同一 chunk
				// 附带 usage（streamParser 先 yield finish 再 yield usage），
				// 若立即 break 会丢失 token 数据。
				finishReason = event.reason;
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

		return { textContent, pendingToolCalls, hasError, errorMessage, finishReason, reasoningText, usage };
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

	/**
	 * 组装每步 token 账：真实 usage + 四类拆分（思考/工具调用/模型回复/用户输入）。
	 * 分摊法：用户输入 = prompt × 估算(用户消息) / 估算(完整请求体)，保证四类与总量自洽。
	 */
	private buildTokenSnapshot(params: {
		request: LLMRequest;
		systemPrompt: string;
		streamResult: Awaited<ReturnType<AgentLoop['consumeStream']>>;
		userText: string;
	}): TokenUsageSnapshot | null {
		const { request, systemPrompt, streamResult, userText } = params;
		const usage = streamResult.usage;
		const hasUsage = usage !== null && usage.inputTokens + usage.outputTokens > 0;

		const prompt = hasUsage ? usage.inputTokens : estimateRequest(systemPrompt, request.messages, request.tools);
		const completion = hasUsage ? usage.outputTokens : estimateText(streamResult.textContent);
		const total = usage?.totalTokens ?? prompt + completion;

		// 思考：优先 usage.reasoning_tokens，缺失时对 reasoning 增量文本估算
		const reasoning = hasUsage && (usage.reasoningTokens ?? 0) > 0
			? usage.reasoningTokens!
			: estimateText(streamResult.reasoningText);

		// 工具调用：对每个 toolCall 的 name+arguments 估算
		const toolCalls = streamResult.pendingToolCalls.reduce(
			(sum, tc) => sum + estimateText(tc.name + tc.arguments),
			0,
		);

		// 模型回复：completion − reasoning − 工具调用估算（clamp ≥ 0）
		const modelOutput = hasUsage
			? Math.max(0, completion - reasoning - toolCalls)
			: estimateText(streamResult.textContent);

		// 用户输入（分摊法）：按估算占比分摊权威 prompt_tokens；有内容时至少 1，避免 round 归零
		const userEst = estimateText(userText);
		const reqEst = estimateRequest(systemPrompt, request.messages, request.tools);
		const userInput =
			prompt > 0 && reqEst > 0 && userEst > 0
				? Math.max(1, Math.round((prompt * userEst) / reqEst))
				: userEst;

		// 上下文 = prompt − user_input（非四类之一）
		const context = Math.max(0, prompt - userInput);

		return {
			prompt_tokens: prompt,
			completion_tokens: completion,
			total_tokens: total,
			...(usage?.reasoningTokens !== undefined ? { reasoning_tokens: usage.reasoningTokens } : {}),
			...(usage?.cacheReadTokens !== undefined ? { cache_read_tokens: usage.cacheReadTokens } : {}),
			...(usage?.cacheWriteTokens !== undefined ? { cache_write_tokens: usage.cacheWriteTokens } : {}),
			reasoning,
			tool_calls: toolCalls,
			model_output: modelOutput,
			user_input: userInput,
			context,
			source: hasUsage ? 'usage' : 'estimated',
		};
	}

	/** 聚合会话累计 token（遍历消息，求和 assistant tokenUsage）。 */
	private aggregateSessionTokens(sessionId: string): number {
		const messages = this.messageStore.loadHistory(sessionId);
		let total = 0;
		for (const m of messages) {
			if (m.role === 'assistant' && 'tokenUsage' in m && m.tokenUsage) {
				total += m.tokenUsage.total_tokens;
			}
		}
		return total;
	}

	/** 发射 session_token_usage 事件（会话级汇总）。 */
	private emitSessionTokenUsage(sessionId: string, baseTotal: number): void {
		const messages = this.messageStore.loadHistory(sessionId);
		let total = 0;
		const breakdown = { reasoning: 0, tool_calls: 0, model_output: 0, user_input: 0, context: 0 };
		for (const m of messages) {
			if (m.role === 'assistant' && 'tokenUsage' in m && m.tokenUsage) {
				const t = m.tokenUsage;
				total += t.total_tokens;
				breakdown.reasoning += t.reasoning;
				breakdown.tool_calls += t.tool_calls;
				breakdown.model_output += t.model_output;
				breakdown.user_input += t.user_input;
				breakdown.context += t.context;
			}
		}
		this.eventBus.emit({
			type: 'session_token_usage',
			sessionId,
			payload: {
				total_tokens: total,
				breakdown,
				delta_tokens: Math.max(0, total - baseTotal),
			},
		});
	}
}
