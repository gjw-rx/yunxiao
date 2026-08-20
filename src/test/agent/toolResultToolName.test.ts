/**
 * AgentLoop 工具结果 toolName 持久化测试（Task 3.2）。
 *
 * 覆盖：模型调用工具后，AgentLoop 写入 messageStore 的 tool 结果消息必须携带
 * 实际工具名（来自 model tool call，而非留空），供后续 Anthropic tool_result 转换使用。
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
import type { Message } from '../../memory/types';

function makeProvider(eventsPerCall: LLMEvent[][]): LLMProvider {
	let callIndex = 0;
	return {
		async *chatCompletion(): AsyncGenerator<LLMEvent> {
			const events = eventsPerCall[Math.min(callIndex, eventsPerCall.length - 1)];
			callIndex++;
			for (const e of events) {
				yield e;
			}
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

class MockStatusTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'git_status',
		description: '查看 git 状态',
		parameters: { type: 'object', properties: {} },
		permissions: 'read',
		canParallel: true,
	};
	async execute(): Promise<{ status: ToolCallStatus; result?: string }> {
		return { status: 'success', result: 'clean' };
	}
}

describe('AgentLoop 工具结果持久化 toolName', () => {
	it('新工具执行完成后 tool 消息携带实际工具名', async () => {
		const registry = new ToolRegistry();
		registry.register(new MockReadTool());
		const router = new ToolRouter(registry);
		const store = new MessageStore();
		const provider = makeProvider([
			[
				{ type: 'toolCall', id: 'call_1', name: 'fs_read_file', arguments: JSON.stringify({ path: '/tmp/a.ts' }) },
				{ type: 'finish', reason: 'tool_use' },
			],
			[{ type: 'textDelta', text: 'done' }, { type: 'finish', reason: 'stop' }],
		]);
		const loop = new AgentLoop(provider, store, router, registry, new EventBus(), {
			model: 'test-model',
			temperature: 0,
			maxTokens: 4096,
			maxSteps: 25,
			workspaceRoots: ['/test'],
		} as never);

		await loop.run('s1', '读取文件');

		const toolMsg = store.loadHistory('s1').find((m) => m.role === 'tool') as (Message & { role: 'tool' }) | undefined;
		assert.ok(toolMsg, '应存在 tool 结果消息');
		assert.strictEqual(toolMsg!.toolCallId, 'call_1');
		assert.strictEqual((toolMsg as unknown as { toolName?: string }).toolName, 'fs_read_file', 'tool 结果应携带实际工具名');
	});

	it('并行同名工具调用的两个 tool 结果各自携带正确工具名', async () => {
		const registry = new ToolRegistry();
		registry.register(new MockStatusTool());
		const router = new ToolRouter(registry);
		const store = new MessageStore();
		const provider = makeProvider([
			[
				{ type: 'toolCall', id: 'call_1', name: 'git_status', arguments: '{}' },
				{ type: 'toolCall', id: 'call_2', name: 'git_status', arguments: '{}' },
				{ type: 'finish', reason: 'tool_use' },
			],
			[{ type: 'textDelta', text: 'done' }, { type: 'finish', reason: 'stop' }],
		]);
		const loop = new AgentLoop(provider, store, router, registry, new EventBus(), {
			model: 'test-model',
			temperature: 0,
			maxTokens: 4096,
			maxSteps: 25,
			workspaceRoots: ['/test'],
		} as never);

		await loop.run('s1', '并行调用两次 git status');

		const toolMsgs = store.loadHistory('s1').filter((m) => m.role === 'tool') as Array<Message & { role: 'tool'; toolName?: string }>;
		assert.strictEqual(toolMsgs.length, 2);
		const byId = new Map(toolMsgs.map((m) => [m.toolCallId, m.toolName]));
		assert.strictEqual(byId.get('call_1'), 'git_status');
		assert.strictEqual(byId.get('call_2'), 'git_status');
	});
});
