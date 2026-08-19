/**
 * AgentLoop 运行配置快照测试 - 覆盖每次 run 入口快照 Provider 与生成配置，
 * 运行中更新 temperature / maxTokens / reasoningEffort 不影响当前 run 后续 step 的请求参数。
 */
import * as assert from 'assert';
import { AgentLoop } from '../../agent/agentLoop';
import { MessageStore } from '../../memory/messageStore';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { EventBus } from '../../core/eventBus';
import type { LLMProvider, LLMEvent, LLMRequest } from '../../llm/types';

function makeTextEvent(text: string): LLMEvent {
	return { type: 'textDelta', text };
}

function makeFinishEvent(reason: 'stop' | 'tool_use' | 'length' = 'stop'): LLMEvent {
	return { type: 'finish', reason };
}

function makeUsageEvent(input: number, output: number, opts?: { total?: number }): LLMEvent {
	return {
		type: 'usage',
		inputTokens: input,
		outputTokens: output,
		...(opts?.total !== undefined ? { totalTokens: opts.total } : {}),
	};
}

/** 轮询等待条件成立（用于等待 provider 流进入挂起点）。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('waitFor 超时');
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** 组装带模型配置的 AgentLoop（内存 MessageStore + 可注入配置覆盖）。 */
function makeAgentLoop(
	provider: LLMProvider,
	configOverrides?: Record<string, unknown>,
): { loop: AgentLoop; store: MessageStore } {
	const store = new MessageStore();
	const eventBus = new EventBus();
	const registry = new ToolRegistry();
	const loop = new AgentLoop(provider, store, new ToolRouter(registry), registry, eventBus, {
		model: 'model-A',
		providerId: 'openai-A',
		temperature: 0.7,
		maxTokens: 4096,
		maxSteps: 25,
		workspaceRoots: ['/test'],
		...configOverrides,
	} as never);
	return { loop, store };
}

describe('AgentLoop 运行配置快照', () => {
	it('运行中更新生成配置不影响当前 run 后续 step 的请求参数', async () => {
		// provider 记录每次调用的请求参数，并在第一次调用后挂起供外部更新配置
		const requests: LLMRequest[] = [];
		let resolveGate: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			resolveGate = resolve;
		});
		let streamStarted = false;
		const provider: LLMProvider = {
			async *chatCompletion(request) {
				requests.push(request);
				yield makeTextEvent('reply');
				if (requests.length === 1) {
					// 第一轮返回工具调用（finish=tool_use），触发工具执行与第二次 step
					streamStarted = true;
					yield { type: 'toolCall', id: 't1', name: 'fs_read_file', arguments: '{}' };
					yield { type: 'finish', reason: 'tool_use' };
					await gate;
				}
				yield makeFinishEvent();
				yield makeUsageEvent(100, 20, { total: 120 });
			},
		};
		const { loop } = makeAgentLoop(provider, { model: 'model-A', temperature: 0.7, maxTokens: 4096, reasoningEffort: 'low' });

		const runPromise = loop.run('s1', 'hello');
		await waitFor(() => streamStarted);
		// 模拟运行中更新生成配置（仅影响之后启动的新 run）
		loop.updateModelConfig({ model: 'model-A', providerId: 'openai-A', temperature: 1.5, maxTokens: 8192, reasoningEffort: 'high' });
		resolveGate();
		await runPromise;

		assert.strictEqual(requests.length, 2, '应发生两次 LLM 调用（两轮 step）');
		for (const req of requests) {
			assert.strictEqual(req.temperature, 0.7, '当前 run 所有 step 应使用启动时 temperature');
			assert.strictEqual(req.maxTokens, 4096, '当前 run 所有 step 应使用启动时 maxTokens');
			assert.strictEqual(req.reasoningEffort, 'low', '当前 run 所有 step 应使用启动时 reasoningEffort');
		}
	});

	it('更新配置后下一次 run 使用新生成配置', async () => {
		const requests: LLMRequest[] = [];
		const provider: LLMProvider = {
			async *chatCompletion(request) {
				requests.push(request);
				yield makeTextEvent('reply');
				yield makeFinishEvent();
				yield makeUsageEvent(100, 20, { total: 120 });
			},
		};
		const { loop } = makeAgentLoop(provider, { model: 'model-A', temperature: 0.7, maxTokens: 4096, reasoningEffort: 'medium' });

		await loop.run('s1', 'first');
		loop.updateModelConfig({ model: 'model-A', providerId: 'openai-A', temperature: 1.5, maxTokens: 8192, reasoningEffort: 'high' });
		await loop.run('s1', 'second');

		assert.strictEqual(requests.length, 2);
		assert.strictEqual(requests[0].temperature, 0.7);
		assert.strictEqual(requests[0].reasoningEffort, 'medium');
		assert.strictEqual(requests[1].temperature, 1.5);
		assert.strictEqual(requests[1].maxTokens, 8192);
		assert.strictEqual(requests[1].reasoningEffort, 'high');
	});
});
