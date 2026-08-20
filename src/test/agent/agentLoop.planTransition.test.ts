/**
 * AgentLoop Plan 状态转换测试。
 * 验证仅当前 run 成功的非空 todo_write 且 run 正常结束可进入 review；
 * Markdown 计划、旧快照、空写入与失败 run 均不可触发审阅。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentLoop } from '../../agent/agentLoop';
import { EventBus } from '../../core/eventBus';
import { SessionPlanModeStore } from '../../core/planModeStore';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import type { LLMEvent, LLMProvider, LLMRequest } from '../../llm/types';
import { MessageStore } from '../../memory/messageStore';
import { SessionFileStore } from '../../memory/sessionFileStore';
import { SessionTodoStore } from '../../memory/sessionTodoStore';
import { TodoWriteTool } from '../../tools/todo/todoWrite';
import type { ToolSchema } from '../../core/types';
import { BaseTool, type ToolExecutionResult } from '../../tools/baseTool';

/** 按脚本回合响应的 LLM 提供者；脚本耗尽后默认返回最终文本。 */
class ScriptedProvider implements LLMProvider {
	/** 已接收的请求。 */
	readonly requests: LLMRequest[] = [];

	/**
	 * @param turns 按顺序消费的回合响应构造器；耗尽后默认 finish。
	 */
	constructor(private readonly turns: Array<() => LLMEvent[]>) {}

	/**
	 * 依次消费脚本回合并返回流式事件。
	 * @param request 本轮 LLM 请求。
	 * @returns 流式响应事件。
	 */
	async *chatCompletion(request: LLMRequest): AsyncGenerator<LLMEvent> {
		this.requests.push(request);
		const turn = this.turns.shift();
		if (turn) {
			for (const event of turn()) {
				yield event;
			}
			return;
		}
		yield { type: 'textDelta', text: '完成' };
		yield { type: 'finish', reason: 'stop' };
	}
}

/** todo_write 工具调用回合（可指定任务列表）。 */
function todoWriteTurn(todos: unknown[]): () => LLMEvent[] {
	return () => [
		{ type: 'toolCall', id: 'c1', name: 'todowrite', arguments: JSON.stringify({ todos }) },
		{ type: 'finish', reason: 'tool_use' },
	];
}

/** 纯文本回合（Markdown 计划等）。 */
function textTurn(text: string): () => LLMEvent[] {
	return () => [
		{ type: 'textDelta', text },
		{ type: 'finish', reason: 'stop' },
	];
}

/** 测试环境装配。 */
function setup(): {
	planMode: SessionPlanModeStore;
	todoStore: SessionTodoStore;
	loopFactory: (provider: ScriptedProvider) => AgentLoop;
	cleanup: () => void;
} {
	const registry = new ToolRegistry();
	const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-plan-trans-'));
	const fileStore = new SessionFileStore('/Users/test/Plan Transition', baseDir);
	const planMode = new SessionPlanModeStore(fileStore, new EventBus());
	const todoStore = new SessionTodoStore(fileStore);
	registry.register(new TodoWriteTool(todoStore, new EventBus()));
	return {
		planMode,
		todoStore,
		loopFactory: (provider) =>
			new AgentLoop(provider, new MessageStore(), new ToolRouter(registry), registry, new EventBus(), {
				model: 'test-model',
				temperature: 0,
				maxTokens: 128,
				maxSteps: 5,
				workspaceRoots: [],
				todoStore,
				planModeStore: planMode,
			}),
		cleanup: () => fs.rmSync(baseDir, { recursive: true, force: true }),
	};
}

describe('AgentLoop Plan 状态转换', () => {
	it('当前 run 成功写入非空 todo_write 且正常结束 → review', async () => {
		const { planMode, loopFactory, cleanup } = setup();
		try {
			planMode.transition('s1', 'planning');
			const provider = new ScriptedProvider([
				todoWriteTurn([
					{ id: 'a', content: '调研', status: 'pending' },
					{ id: 'b', content: '实现', status: 'pending' },
				]),
			]);
			await loopFactory(provider).run('s1', '规划一下');
			assert.strictEqual(planMode.getState('s1').stage, 'review');
			assert.strictEqual(planMode.getState('s1').draftCreated, true);
		} finally {
			cleanup();
		}
	});

	it('空 todo_write 不进入 review', async () => {
		const { planMode, loopFactory, cleanup } = setup();
		try {
			planMode.transition('s1', 'planning');
			const provider = new ScriptedProvider([todoWriteTurn([])]);
			await loopFactory(provider).run('s1', '规划一下');
			assert.strictEqual(planMode.getState('s1').stage, 'planning');
		} finally {
			cleanup();
		}
	});

	it('Markdown 计划（无 todo_write）不进入 review', async () => {
		const { planMode, loopFactory, cleanup } = setup();
		try {
			planMode.transition('s1', 'planning');
			const provider = new ScriptedProvider([textTurn('Plan:\n1. 调研\n2. 实现')]);
			await loopFactory(provider).run('s1', '规划一下');
			assert.strictEqual(planMode.getState('s1').stage, 'planning');
		} finally {
			cleanup();
		}
	});

	it('旧 Todo 快照不触发 review', async () => {
		const { planMode, todoStore, loopFactory, cleanup } = setup();
		try {
			todoStore.write('s1', [{ id: 'old', content: '旧任务', status: 'in_progress' }]);
			planMode.transition('s1', 'planning');
			const provider = new ScriptedProvider([textTurn('先看看')]);
			await loopFactory(provider).run('s1', '规划一下');
			assert.strictEqual(planMode.getState('s1').stage, 'planning');
		} finally {
			cleanup();
		}
	});

	it('run 失败（LLM 错误）不进入 review', async () => {
		const { planMode, loopFactory, cleanup } = setup();
		try {
			planMode.transition('s1', 'planning');
			const provider = new ScriptedProvider([
				() => [
					{ type: 'toolCall', id: 'c1', name: 'todowrite', arguments: JSON.stringify({ todos: [{ id: 'a', content: '调研', status: 'pending' }] }) },
					{ type: 'finish', reason: 'tool_use' },
				],
				() => [{ type: 'error', error: 'boom' }],
			]);
			await loopFactory(provider).run('s1', '规划一下');
			assert.strictEqual(planMode.getState('s1').stage, 'planning');
		} finally {
			cleanup();
		}
	});

	it('todo_write 参数校验失败不进入 review', async () => {
		const { planMode, loopFactory, cleanup } = setup();
		try {
			planMode.transition('s1', 'planning');
			// 重复 id 触发 TodoWriteTool 校验失败 → 工具返回 error
			const provider = new ScriptedProvider([
				todoWriteTurn([
					{ id: 'a', content: '调研', status: 'pending' },
					{ id: 'a', content: '实现', status: 'pending' },
				]),
			]);
			await loopFactory(provider).run('s1', '规划一下');
			assert.strictEqual(planMode.getState('s1').stage, 'planning');
		} finally {
			cleanup();
		}
	});

	it('normal 阶段 todo_write 成功不进入 review（不改变状态）', async () => {
		const { planMode, loopFactory, cleanup } = setup();
		try {
			const provider = new ScriptedProvider([
				todoWriteTurn([
					{ id: 'a', content: '任务一', status: 'pending' },
					{ id: 'b', content: '任务二', status: 'pending' },
				]),
			]);
			await loopFactory(provider).run('s1', '开始');
			assert.strictEqual(planMode.getState('s1').stage, 'normal');
		} finally {
			cleanup();
		}
	});

	it('executing 阶段全部任务完成自动回到 normal', async () => {
		const { planMode, todoStore, loopFactory, cleanup } = setup();
		try {
			planMode.transition('s1', 'planning');
			planMode.transition('s1', 'review');
			planMode.transition('s1', 'executing');
			todoStore.write('s1', [{ id: 'a', content: '任务一', status: 'pending' }]);
			// 执行 run：先把任务标记 completed，再结束
			const provider = new ScriptedProvider([
				todoWriteTurn([{ id: 'a', content: '任务一', status: 'completed' }]),
			]);
			await loopFactory(provider).run('s1', '执行计划');
			assert.strictEqual(planMode.getState('s1').stage, 'normal');
		} finally {
			cleanup();
		}
	});

	it('executing 阶段仍有活跃任务时保持 executing', async () => {
		const { planMode, todoStore, loopFactory, cleanup } = setup();
		try {
			planMode.transition('s1', 'planning');
			planMode.transition('s1', 'review');
			planMode.transition('s1', 'executing');
			todoStore.write('s1', [
				{ id: 'a', content: '任务一', status: 'in_progress' },
				{ id: 'b', content: '任务二', status: 'pending' },
			]);
			const provider = new ScriptedProvider([
				todoWriteTurn([
					{ id: 'a', content: '任务一', status: 'completed' },
					{ id: 'b', content: '任务二', status: 'pending' },
				]),
			]);
			await loopFactory(provider).run('s1', '执行');
			assert.strictEqual(planMode.getState('s1').stage, 'executing');
		} finally {
			cleanup();
		}
	});
});
