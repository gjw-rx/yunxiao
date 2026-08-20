/**
 * AgentLoop 模型可见任务状态检测测试。
 * 覆盖：连续 todo_write 更新的工具结果路径、压缩检查点上下文路径、遗留会话恢复路径。
 */
import * as assert from 'assert';
import { AgentLoop } from '../../agent/agentLoop';
import { EventBus } from '../../core/eventBus';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import type { LLMEvent, LLMProvider, LLMRequest } from '../../llm/types';
import { MessageStore } from '../../memory/messageStore';
import type { SessionTodoStore } from '../../memory/sessionTodoStore';
import type { TodoItem, TodoSnapshot } from '../../memory/todoTypes';
import { TodoWriteTool } from '../../tools/todo/todoWrite';

/** 内存版会话任务存储，行为对齐 SessionTodoStore。 */
class FakeTodoStore {
	private snapshot: TodoSnapshot = { todos: [] };

	read(_sessionId: string): TodoSnapshot {
		return this.snapshot;
	}

	write(_sessionId: string, value: unknown): TodoSnapshot {
		const todos = Array.isArray(value)
			? (value as readonly TodoItem[]).map((item) => ({ id: item.id, content: item.content, status: item.status }))
			: [];
		this.snapshot = { todos };
		return this.snapshot;
	}

	formatActiveContext(_sessionId: string): string | null {
		const active = this.snapshot.todos.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress');
		if (active.length === 0) {
			return null;
		}
		return [
			'当前会话的任务进度（由本地 todo_write 工具维护）：',
			...active.map((todo) => `- [${todo.status === 'in_progress' ? '进行中' : '待办'}] ${todo.id}. ${todo.content}`),
			'继续执行这些未完成任务；不要重复已完成任务。',
		].join('\n');
	}

	/** 预置任务快照。 @param todos 任务列表。 */
	setTodos(todos: readonly TodoItem[]): void {
		this.snapshot = { todos };
	}
}

/** 记录请求且立即返回文本结束的 Provider。 */
class TextOnlyProvider implements LLMProvider {
	/** 已接收的请求。 */
	readonly requests: LLMRequest[] = [];

	/**
	 * 记录请求并返回一条最终文本。
	 * @param request 本轮 LLM 请求。
	 * @returns 流式响应事件。
	 */
	async *chatCompletion(request: LLMRequest): AsyncGenerator<LLMEvent> {
		this.requests.push(request);
		yield { type: 'textDelta', text: '完成' };
		yield { type: 'finish', reason: 'stop' };
	}
}

/** 按预置事件序列应答并记录请求的 Provider。 */
function createSequenceProvider(eventsPerCall: readonly (readonly LLMEvent[])[]): { provider: LLMProvider; requests: LLMRequest[] } {
	const requests: LLMRequest[] = [];
	let callIndex = 0;
	const provider: LLMProvider = {
		async *chatCompletion(request: LLMRequest): AsyncGenerator<LLMEvent> {
			requests.push(request);
			const events = eventsPerCall[Math.min(callIndex, eventsPerCall.length - 1)];
			callIndex++;
			for (const event of events) {
				yield event;
			}
		},
	};
	return { provider, requests };
}

/** 构造 todo_write 工具调用事件。 @param id 调用 ID。 @param todos 任务列表。 @returns 工具调用事件。 */
function makeTodoCall(id: string, todos: readonly TodoItem[]): LLMEvent {
	return { type: 'toolCall', id, name: 'todo_write', arguments: JSON.stringify({ todos }) };
}

/** 构造 AgentLoop。 @param provider LLM Provider。 @param todoStore 任务存储。 @param store 消息存储。 @returns AgentLoop。 */
function makeLoop(
	provider: LLMProvider,
	todoStore: FakeTodoStore,
	store: MessageStore = new MessageStore(),
	registry: ToolRegistry = new ToolRegistry(),
): { loop: AgentLoop; store: MessageStore; registry: ToolRegistry } {
	const eventBus = new EventBus();
	const todoStoreRef = todoStore as unknown as SessionTodoStore;
	if (!registry.has('todo_write')) {
		registry.register(new TodoWriteTool(todoStoreRef, eventBus));
	}
	const loop = new AgentLoop(provider, store, new ToolRouter(registry), registry, eventBus, {
		model: 'test-model',
		temperature: 0,
		maxTokens: 4096,
		maxSteps: 25,
		workspaceRoots: ['/test'],
		todoStore: todoStoreRef,
	});
	return { loop, store, registry };
}

describe('AgentLoop 模型可见任务状态', () => {
	describe('连续 todo_write 更新', () => {
		it('后续请求通过工具结果获得任务状态，历史前不插入可变任务 system 消息', async () => {
			const todoStore = new FakeTodoStore();
			const { provider, requests } = createSequenceProvider([
				[
					makeTodoCall('call-1', [
						{ id: 'a', content: '任务A', status: 'in_progress' },
						{ id: 'b', content: '任务B', status: 'pending' },
					]),
					{ type: 'finish', reason: 'tool_use' },
				],
				[
					makeTodoCall('call-2', [
						{ id: 'a', content: '任务A', status: 'completed' },
						{ id: 'b', content: '任务B', status: 'in_progress' },
					]),
					{ type: 'finish', reason: 'tool_use' },
				],
				[{ type: 'textDelta', text: '完成' }, { type: 'finish', reason: 'stop' }],
			]);
			const { loop } = makeLoop(provider, todoStore);

			await loop.run('s1', '完成任务 A');

			assert.strictEqual(requests.length, 3);
			// 首次请求：尚无任务快照，仅主 system 提示词
			assert.strictEqual(requests[0].messages.filter((message) => message.role === 'system').length, 1);
			// 后续请求：完整历史之前不再插入可变任务 system 消息
			for (const request of requests.slice(1)) {
				const systemMessages = request.messages.filter((message) => message.role === 'system');
				assert.strictEqual(systemMessages.length, 1, '历史前不应有第二条 system 消息');
				assert.ok(!systemMessages[0].content.includes('任务进度'));
			}
			// 历史前缀稳定：两次连续更新的请求除新增尾部外，前缀（user+assistant+tool）一致
			assert.deepStrictEqual(
				requests[1].messages.slice(1, 4),
				requests[2].messages.slice(1, 4),
			);
			// 最新任务状态经由工具结果进入模型上下文
			const lastTool = requests[2].messages.find((message) => message.role === 'tool');
			assert.ok(lastTool && lastTool.content.includes('任务B'));
		});
	});

	describe('压缩后恢复', () => {
		it('从压缩检查点任务上下文获得活跃任务，不注入额外恢复消息', async () => {
			const todoStore = new FakeTodoStore();
			todoStore.setTodos([
				{ id: 'a', content: '任务A', status: 'in_progress' },
				{ id: 'b', content: '任务B', status: 'pending' },
			]);
			const store = new MessageStore();
			store.append('s1', { role: 'user', content: '保留上下文' });
			store.append('s1', {
				role: 'compaction',
				summary: '已压缩摘要',
				firstKeptSeq: 0,
				todoContext:
					'当前会话的任务进度（由本地 todo_write 工具维护）：\n- [进行中] a. 任务A\n- [待办] b. 任务B\n继续执行这些未完成任务；不要重复已完成任务。',
			});

			const provider = new TextOnlyProvider();
			const { loop, store: historyStore } = makeLoop(provider, todoStore, store);

			await loop.run('s1', '继续');

			const request = provider.requests[0];
			// 仅 3 条 system：主提示词 + 摘要 + 检查点任务上下文，无额外恢复注入
			const systemMessages = request.messages.filter((message) => message.role === 'system');
			assert.strictEqual(systemMessages.length, 3);
			assert.strictEqual(systemMessages[1].content, '已压缩摘要');
			assert.ok(systemMessages[2].content.includes('任务A'));
			// 聊天历史中不新增合成任务消息
			assert.ok(!historyStore.loadHistory('s1').some((message) => message.role === 'system' && message.content.includes('任务进度')));
		});
	});

	describe('遗留会话恢复', () => {
		it('有效历史与检查点均无任务状态时注入临时恢复上下文，且不写入历史', async () => {
			const todoStore = new FakeTodoStore();
			todoStore.setTodos([{ id: 'a', content: '任务A', status: 'in_progress' }]);
			const store = new MessageStore();
			store.append('s1', { role: 'assistant', content: '旧回复' });

			const provider = new TextOnlyProvider();
			const { loop, store: historyStore } = makeLoop(provider, todoStore, store);

			await loop.run('s1', '继续');

			const request = provider.requests[0];
			// 主 system 提示词之后紧跟临时恢复上下文
			assert.strictEqual(request.messages[1].role, 'system');
			assert.ok(request.messages[1].content.includes('任务A'));
			// 恢复上下文不写入消息历史（也不进入聊天时间线）
			assert.ok(!historyStore.loadHistory('s1').some((message) => 'content' in message && message.content.includes('任务A')));
		});

		it('任务全部完成或取消时不注入恢复上下文', async () => {
			const todoStore = new FakeTodoStore();
			todoStore.setTodos([
				{ id: 'a', content: '任务A', status: 'completed' },
				{ id: 'b', content: '任务B', status: 'cancelled' },
			]);
			const store = new MessageStore();
			store.append('s1', { role: 'assistant', content: '旧回复' });

			const provider = new TextOnlyProvider();
			const { loop } = makeLoop(provider, todoStore, store);

			await loop.run('s1', '继续');

			const request = provider.requests[0];
			assert.strictEqual(request.messages.filter((message) => message.role === 'system').length, 1);
			assert.ok(!request.messages.some((message) => message.role === 'system' && message.content.includes('任务进度')));
		});
	});
});
