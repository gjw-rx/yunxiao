import * as assert from 'assert';
import { AgentLoop } from '../../agent/agentLoop';
import { MessageStore } from '../../memory/messageStore';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { EventBus } from '../../core/eventBus';
import type { LLMProvider, LLMEvent } from '../../llm/types';
import type { AgentEvent } from '../../core/eventBus';
import type { Message } from '../../memory/types';

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
		temperature: 0,
		maxTokens: 4096,
		maxSteps: 25,
		workspaceRoots: ['/test'],
		...configOverrides,
	} as never);
	return { loop, store };
}

function assistantMessages(store: MessageStore, sessionId: string): Message[] {
	return store.loadHistory(sessionId).filter((m) => m.role === 'assistant');
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

describe('AgentLoop 模型归属落账', () => {
	it('运行中切换默认模型不改变当前 run 的账归属', async () => {
		// provider 流在消费中途挂起（模拟"调用进行中"），此时外部切换默认模型
		let resolveGate: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			resolveGate = resolve;
		});
		let streamStarted = false;
		const provider: LLMProvider = {
			async *chatCompletion() {
				streamStarted = true;
				yield makeTextEvent('reply');
				yield makeFinishEvent();
				await gate;
				yield makeUsageEvent(100, 20, { total: 120 });
			},
		};
		const { loop, store } = makeAgentLoop(provider, { model: 'model-A', providerId: 'openai-A' });

		const runPromise = loop.run('s1', 'hello');
		await waitFor(() => streamStarted);
		// 模拟用户切换默认模型为 B（仅影响后续 run 的请求配置）
		loop.updateModelConfig({ model: 'model-B', providerId: 'openai-B', temperature: 0, maxTokens: 4096 });
		resolveGate();
		await runPromise;

		const msgs = assistantMessages(store, 's1');
		assert.strictEqual(msgs.length, 1);
		const tu = (msgs[0] as { tokenUsage?: { provider_id?: string; model_id?: string; model_label?: string } }).tokenUsage;
		assert.ok(tu, 'assistant 消息应携带 tokenUsage');
		assert.strictEqual(tu.provider_id, 'openai-A');
		assert.strictEqual(tu.model_id, 'model-A');
		assert.strictEqual(tu.model_label, 'model-A');
	});

	it('切换默认模型后下一次 run 使用新模型落账', async () => {
		const provider: LLMProvider = {
			async *chatCompletion() {
				yield makeTextEvent('reply');
				yield makeFinishEvent();
				yield makeUsageEvent(100, 20, { total: 120 });
			},
		};
		const { loop, store } = makeAgentLoop(provider, { model: 'model-A', providerId: 'openai-A' });

		// 第一次 run 使用 model-A
		await loop.run('s1', 'first');
		// 切换默认模型
		loop.updateModelConfig({ model: 'model-B', providerId: 'openai-B', temperature: 0, maxTokens: 4096 });
		// 第二次 run 使用 model-B
		await loop.run('s1', 'second');

		const msgs = assistantMessages(store, 's1');
		assert.strictEqual(msgs.length, 2);
		const firstTu = (msgs[0] as { tokenUsage?: { provider_id?: string; model_id?: string } }).tokenUsage!;
		const secondTu = (msgs[1] as { tokenUsage?: { provider_id?: string; model_id?: string } }).tokenUsage!;
		assert.strictEqual(firstTu.provider_id, 'openai-A');
		assert.strictEqual(firstTu.model_id, 'model-A');
		assert.strictEqual(secondTu.provider_id, 'openai-B');
		assert.strictEqual(secondTu.model_id, 'model-B');
	});

	it('持久化序列化结果不含鉴权信息', async () => {
		// provider 内部含密钥，token 账及消息序列化不得泄露
		const secret = 'sk-test-secret-abc123';
		const provider: LLMProvider & { apiKey: string } = {
			apiKey: secret,
			async *chatCompletion() {
				yield makeTextEvent('reply');
				yield makeFinishEvent();
				yield makeUsageEvent(100, 20, { total: 120 });
			},
		};
		const { loop, store } = makeAgentLoop(provider, { model: 'model-A', providerId: 'openai-A' });
		await loop.run('s1', 'hello');

		const msgs = store.loadHistory('s1');
		const serialized = JSON.stringify(msgs);
		assert.ok(!serialized.includes(secret), '序列化结果不应包含 API Key');
		assert.ok(!serialized.includes('apiKey'), '序列化结果不应包含 apiKey 字段');
		assert.ok(!serialized.includes('Authorization'), '序列化结果不应包含鉴权 header 字段');

		// token 账只含非敏感模型元数据
		const assistant = msgs.find((m) => m.role === 'assistant') as Message & { tokenUsage?: Record<string, unknown> };
		assert.ok(assistant.tokenUsage, 'assistant 消息应携带 tokenUsage');
		const keys = Object.keys(assistant.tokenUsage);
		assert.ok(!keys.includes('apiKey') && !keys.includes('baseURL'), 'token 账只含非敏感字段');
		assert.strictEqual(assistant.tokenUsage.model_id, 'model-A');
	});

	it('旧消息无模型元数据时不写 provider/模型字段（保持旧归档兼容）', async () => {
		const provider: LLMProvider = {
			async *chatCompletion() {
				yield makeTextEvent('reply');
				yield makeFinishEvent();
				yield makeUsageEvent(100, 20, { total: 120 });
			},
		};
		// 未配置 providerId 时不写 provider_id；model_id 仍写入（模型名来自 run 快照）
		const { loop, store } = makeAgentLoop(provider, { providerId: undefined });
		await loop.run('s1', 'hello');

		const msgs = assistantMessages(store, 's1');
		const tu = (msgs[0] as { tokenUsage?: Record<string, unknown> }).tokenUsage!;
		assert.strictEqual(tu.provider_id, undefined);
		assert.strictEqual(tu.model_id, 'model-A');
	});
});