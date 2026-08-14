/**
 * AgentLoop MCP 端到端测试共享基础设施（任务 11.5/11.6/11.7）。
 *
 * 职责：
 * - 构造可记录调用次数的 Mock LLM Provider（事件按轮次消费）
 * - 装配 McpClientManager + ToolRegistry + ToolRouter + AgentLoop 的完整链路
 * - 提供 STDIO / Streamable HTTP fixture 的启动与清理登记
 *
 * 仅测试使用，不进入生产代码。
 */
import * as assert from 'assert';
import { McpClientManager, type McpManagerCallbacks } from '../../mcp/manager';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { EventBus } from '../../core/eventBus';
import { MessageStore } from '../../memory/messageStore';
import { AgentLoop } from '../../agent/agentLoop';
import type { LLMProvider, LLMEvent } from '../../llm/types';
import type { AgentEvent } from '../../core/eventBus';
import type { ApprovalGateway } from '../../core/approvalGateway';
import type { McpServerRuntimeConfig } from '../../mcp/types';

/** 等待毫秒。 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 构造 toolCall 事件。 */
export function makeToolCallEvent(id: string, name: string, args: Record<string, unknown>): LLMEvent {
	return { type: 'toolCall', id, name, arguments: JSON.stringify(args) };
}

/** 构造文本增量事件。 */
export function makeTextEvent(text: string): LLMEvent {
	return { type: 'textDelta', text };
}

/** 构造 finish 事件。 */
export function makeFinishEvent(reason: 'stop' | 'tool_use' | 'length' = 'stop'): LLMEvent {
	return { type: 'finish', reason };
}

/** 记录调用次数的 Mock Provider：事件按轮次消费，最后一轮循环使用。 */
export interface CallRecorderProvider extends LLMProvider {
	/** 已消费的轮次（chatCompletion 调用次数）。 */
	readonly callCount: () => number;
}

/** 构造可记录调用次数的 Mock Provider。 */
export function makeProvider(eventsPerCall: LLMEvent[][]): CallRecorderProvider {
	let callIndex = 0;
	return {
		async *chatCompletion(): AsyncGenerator<LLMEvent> {
			const events = eventsPerCall[Math.min(callIndex, eventsPerCall.length - 1)];
			callIndex++;
			for (const e of events) {
				yield e;
			}
		},
		callCount: () => callIndex,
	};
}

/** 装配后的完整测试链路。 */
export interface McpE2eHarness {
	readonly loop: AgentLoop;
	readonly store: MessageStore;
	readonly registry: ToolRegistry;
	readonly manager: McpClientManager;
	readonly events: AgentEvent[];
	readonly provider: CallRecorderProvider;
	/** 释放 Manager 与等待子进程/HTTP server 退出。 */
	dispose(): Promise<void>;
}

/**
 * 装配 McpClientManager + AgentLoop 完整链路。
 *
 * @param provider Mock Provider
 * @param configs serverId → 运行时配置（经 Manager.applyConfig 装配）
 * @param opts 可选：approval、mcpInstructions、workspaceTrusted、extraAgentConfig
 * @returns 测试链路句柄
 */
export async function makeMcpE2eHarness(
	provider: LLMProvider,
	configs: ReadonlyMap<string, McpServerRuntimeConfig>,
	opts: {
		readonly approval?: ApprovalGateway;
		readonly workspaceTrusted?: boolean;
		readonly mcpInstructions?: boolean;
		readonly extraAgentConfig?: Record<string, unknown>;
	} = {},
): Promise<McpE2eHarness> {
	const registry = new ToolRegistry();
	const events: AgentEvent[] = [];
	const eventBus = new EventBus();
	const originalEmit = eventBus.emit.bind(eventBus);
	eventBus.emit = (e: AgentEvent) => {
		events.push(e);
		return originalEmit(e);
	};

	const manager = new McpClientManager({
		registry,
		workspaceTrusted: opts.workspaceTrusted ?? true,
		callbacks: {
			onStatusChange: () => undefined,
			onInstructions: () => undefined,
		} satisfies McpManagerCallbacks,
	});
	await manager.applyConfig(1, configs);

	const router = new ToolRouter(registry, opts.approval);
	const store = new MessageStore();
	const loop = new AgentLoop(provider, store, router, registry, eventBus, {
		model: 'test-model',
		temperature: 0,
		maxTokens: 4096,
		maxSteps: 25,
		workspaceRoots: ['/test'],
		...(opts.mcpInstructions
			? {
				mcpInstructionsProvider: () =>
					manager.getInstructions().map((i) => ({ serverId: i.serverId, content: i.content })),
			}
			: {}),
		...opts.extraAgentConfig,
	} as never);

	return {
		loop,
		store,
		registry,
		manager,
		events,
		provider: provider as CallRecorderProvider,
		dispose: async () => {
			await manager.dispose();
			await sleep(100);
		},
	};
}

/** 断言注册表中存在指定 exposed 工具（等待就绪）。 */
export async function waitForTool(registry: ToolRegistry, exposedName: string, timeoutMs = 10000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (; ;) {
		if (registry.list().some((s) => s.name === exposedName)) {
			return;
		}
		if (Date.now() > deadline) {
			assert.fail(`工具 ${exposedName} 未在 ${timeoutMs}ms 内注册，当前：${registry.list().map((s) => s.name).join(',')}`);
		}
		await sleep(25);
	}
}
