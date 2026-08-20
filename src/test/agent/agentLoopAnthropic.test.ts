/**
 * AgentLoop Anthropic 端到端测试（Task 6.2）。
 *
 * 验证 Anthropic 配置下的完整循环：多轮对话 → Claude tool use → ToolRouter 执行 →
 * tool result 回传 → 最终文本，并检查事件顺序、工具名持久化与 token 快照
 * （provider=anthropic 归属 + cache 明细只作为输入侧组成，不重复计入 total）。
 *
 * 使用可注入的事件序列模拟 Anthropic 模型响应（provider=anthropic），不依赖真实网络。
 */
import * as assert from 'assert';
import { AgentLoop } from '../../agent/agentLoop';
import { MessageStore } from '../../memory/messageStore';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { EventBus } from '../../core/eventBus';
import type { LLMProvider, LLMEvent } from '../../llm/types';
import type { ToolSchema, ToolCallStatus } from '../../core/types';
import { BaseTool } from '../../tools/baseTool';
import type { AgentEvent } from '../../core/eventBus';
import type { Message } from '../../memory/types';

/** 记录 LLM 调用次数并提供按轮次注入的事件序列。 */
function makeProvider(eventsPerCall: LLMEvent[][]): { provider: LLMProvider; calls: () => number } {
	let callIndex = 0;
	let callCount = 0;
	return {
		calls: () => callCount,
		provider: {
			async *chatCompletion(): AsyncGenerator<LLMEvent> {
				const events = eventsPerCall[Math.min(callIndex, eventsPerCall.length - 1)];
				callIndex++;
				callCount++;
				for (const e of events) {
					yield e;
				}
			},
		},
	};
}

class MockReadTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs_read_file',
		description: '读取文件',
		parameters: { type: 'object', properties: { path: { type: 'string' } } },
		permissions: 'read',
		canParallel: true,
	};
	async execute(args: Record<string, unknown>): Promise<{ status: ToolCallStatus; result?: string }> {
		return { status: 'success', result: `content of ${args.path}` };
	}
}

describe('AgentLoop Anthropic 端到端', () => {
	it('Claude tool use → ToolRouter 结果 → tool result 回传 → 最终文本', async () => {
		const registry = new ToolRegistry();
		registry.register(new MockReadTool());
		const router = new ToolRouter(registry);
		const store = new MessageStore();
		const events: AgentEvent[] = [];
		const eventBus = new EventBus();
		const originalEmit = eventBus.emit.bind(eventBus);
		eventBus.emit = (e: AgentEvent) => {
			events.push(e);
			return originalEmit(e);
		};

		const { provider, calls } = makeProvider([
			// 第一轮：Claude 返回单个 tool use（Anthropic 大缓存命中的 usage）
			[
				{ type: 'toolCall', id: 'toolu_1', name: 'fs_read_file', arguments: JSON.stringify({ path: '/tmp/a.ts' }) },
				{ type: 'finish', reason: 'tool_use' },
				{ type: 'usage', inputTokens: 11583, outputTokens: 105, totalTokens: 11688, noCacheTokens: 191, cacheReadTokens: 11392, cacheWriteTokens: 0, reasoningTokens: 59 },
			],
			// 第二轮：读取结果后输出最终文本
			[
				{ type: 'textDelta', text: '文件内容是' },
				{ type: 'textDelta', text: 'content of /tmp/a.ts' },
				{ type: 'finish', reason: 'stop' },
				{ type: 'usage', inputTokens: 12000, outputTokens: 40, totalTokens: 12040, noCacheTokens: 608, cacheReadTokens: 11392, cacheWriteTokens: 0, reasoningTokens: 0 },
			],
		]);

		const loop = new AgentLoop(provider, store, router, registry, eventBus, {
			model: 'claude-3-5-sonnet-latest',
			providerId: 'anthropic',
			temperature: 0,
			maxTokens: 4096,
			maxSteps: 25,
			workspaceRoots: ['/test'],
		} as never);

		await loop.run('s1', '读取 /tmp/a.ts');

		// 1. 多轮对话：两次 LLM 调用
		assert.strictEqual(calls(), 2, '应发生两次 LLM 调用（tool use 轮 + 最终文本轮）');

		// 2. 事件顺序：tool_state 先于最终 assistant 文本
		const toolEvents = events.filter((e) => e.type === 'tool_state_change');
		assert.ok(toolEvents.length >= 1, '应发出工具状态事件');

		// 3. tool result 持久化带 toolName
		const toolMsg = store.loadHistory('s1').find((m) => m.role === 'tool') as (Message & { role: 'tool'; toolName?: string });
		assert.ok(toolMsg, '应持久化 tool 结果消息');
		assert.strictEqual(toolMsg!.toolCallId, 'toolu_1');
		assert.strictEqual(toolMsg!.toolName, 'fs_read_file', 'tool 结果应携带实际工具名');

		// 4. 最终回复文本
		const finalText = store.loadHistory('s1')
			.filter((m) => m.role === 'assistant')
			.map((m) => (m as { content: string }).content)
			.join('');
		assert.ok(finalText.includes('content of /tmp/a.ts'), '最终回复应包含工具结果内容');

		// 5. token 快照：provider_id=anthropic、模型归属正确、cache 明细只作输入侧组成
		const assistantMsgs = store.loadHistory('s1').filter((m) => m.role === 'assistant') as Array<Message & { tokenUsage?: Record<string, unknown> }>;
		const firstTu = assistantMsgs[0]!.tokenUsage!;
		assert.strictEqual(firstTu.provider_id, 'anthropic');
		assert.strictEqual(firstTu.model_id, 'claude-3-5-sonnet-latest');
		// 大缓存命中：input=11583（=191 noCache + 11392 cacheRead），total=11688，不重复加 cache 组成
		assert.strictEqual(firstTu.prompt_tokens, 11583, 'prompt 应为未缓存输入 + cache read 之和');
		assert.strictEqual(firstTu.cache_read_tokens, 11392);
		assert.strictEqual(firstTu.no_cache_tokens, 191);
		assert.strictEqual(firstTu.completion_tokens, 105);
		assert.strictEqual(firstTu.total_tokens, 11688, 'total 不应额外叠加 cache 明细');
		assert.strictEqual(firstTu.reasoning_tokens, 59);
	});
});
