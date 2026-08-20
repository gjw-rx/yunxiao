/**
 * AgentLoop Plan 模式工具暴露测试。
 * 验证 planning/review 阶段仅向模型暴露 read 权限工具（含 todo_write），
 * terminal/write/execute/destructive 被过滤，normal/executing 阶段为完整工具集。
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
import { BaseTool, type ToolExecutionResult } from '../../tools/baseTool';
import type { ToolSchema } from '../../core/types';

/** 记录请求且立即结束的 LLM 提供者。 */
class CapturingProvider implements LLMProvider {
	/** 已接收的请求。 */
	readonly requests: LLMRequest[] = [];

	/**
	 * 记录请求并返回一条最终文本。
	 * @param request 本轮 LLM 请求。
	 * @returns 流式响应事件。
	 */
	async *chatCompletion(request: LLMRequest): AsyncGenerator<LLMEvent> {
		this.requests.push(request);
		yield { type: 'textDelta', text: 'ok' };
		yield { type: 'finish', reason: 'stop' };
	}
}

/**
 * 构造指定权限的工具。
 * @param name 工具名。
 * @param permissions 权限级别。
 * @returns 测试工具实例。
 */
function fakeTool(name: string, permissions: ToolSchema['permissions']): BaseTool {
	return new (class extends BaseTool {
		readonly schema: ToolSchema = {
			name,
			description: 'fake tool',
			parameters: { type: 'object', properties: {} },
			permissions,
		};
		async execute(): Promise<ToolExecutionResult> {
			return { status: 'success', result: 'ok' };
		}
	})();
}

/** 测试环境装配。 */
function setup(): {
	provider: CapturingProvider;
	planMode: SessionPlanModeStore;
	loop: AgentLoop;
	cleanup: () => void;
} {
	const provider = new CapturingProvider();
	const store = new MessageStore();
	const registry = new ToolRegistry();
	registry.register(fakeTool('fs_read_file', 'read'));
	registry.register(fakeTool('todo_write', 'read'));
	registry.register(fakeTool('fs_write_file', 'write'));
	registry.register(fakeTool('terminal_exec', 'execute'));
	registry.register(fakeTool('fs_delete_file', 'destructive'));
	const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-plan-tools-'));
	const fileStore = new SessionFileStore('/Users/test/Plan Tools', baseDir);
	const planMode = new SessionPlanModeStore(fileStore, new EventBus());
	const loop = new AgentLoop(provider, store, new ToolRouter(registry), registry, new EventBus(), {
		model: 'test-model',
		temperature: 0,
		maxTokens: 128,
		maxSteps: 3,
		workspaceRoots: [],
		planModeStore: planMode,
	});
	return {
		provider,
		planMode,
		loop,
		cleanup: () => fs.rmSync(baseDir, { recursive: true, force: true }),
	};
}

/** 读取首次请求暴露的工具名集合。 */
function exposedTools(provider: CapturingProvider): Set<string> {
	const tools = provider.requests[0]?.tools ?? [];
	return new Set(tools.map((tool) => tool.name));
}

describe('AgentLoop Plan 模式工具暴露', () => {
	const ALL = new Set(['fs_read_file', 'todo_write', 'fs_write_file', 'terminal_exec', 'fs_delete_file']);
	const READ_ONLY = new Set(['fs_read_file', 'todo_write']);

	it('normal 阶段暴露完整工具集', async () => {
		const { provider, planMode, loop, cleanup } = setup();
		try {
			await loop.run('s1', 'hi');
			assert.deepStrictEqual(exposedTools(provider), ALL);
			assert.strictEqual(planMode.getState('s1').stage, 'normal');
		} finally {
			cleanup();
		}
	});

	it('planning 阶段仅暴露 read 工具与 todo_write', async () => {
		const { provider, planMode, loop, cleanup } = setup();
		try {
			planMode.transition('s1', 'planning');
			await loop.run('s1', '调研一下');
			assert.deepStrictEqual(exposedTools(provider), READ_ONLY);
			assert.ok(!exposedTools(provider).has('terminal_exec'));
		} finally {
			cleanup();
		}
	});

	it('review 阶段仅暴露 read 工具与 todo_write', async () => {
		const { provider, planMode, loop, cleanup } = setup();
		try {
			planMode.transition('s1', 'planning');
			planMode.transition('s1', 'review');
			await loop.run('s1', '再看下');
			assert.deepStrictEqual(exposedTools(provider), READ_ONLY);
		} finally {
			cleanup();
		}
	});

	it('executing 阶段恢复完整工具集', async () => {
		const { provider, planMode, loop, cleanup } = setup();
		try {
			planMode.transition('s1', 'planning');
			planMode.transition('s1', 'review');
			planMode.transition('s1', 'executing');
			await loop.run('s1', '开始执行');
			assert.deepStrictEqual(exposedTools(provider), ALL);
		} finally {
			cleanup();
		}
	});
});
