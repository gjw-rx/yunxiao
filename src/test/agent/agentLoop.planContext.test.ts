/**
 * AgentLoop Plan 规划上下文测试。
 * 验证 planning 阶段注入临时规划指令（不写入历史）、抑制"继续执行活跃任务"恢复提示，
 * 且普通模式不受影响。
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

/** 只读测试工具。 */
function readTool(): BaseTool {
	return new (class extends BaseTool {
		readonly schema: ToolSchema = {
			name: 'fs_read_file',
			description: 'fake read',
			parameters: { type: 'object', properties: {} },
			permissions: 'read',
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
	todoStore: SessionTodoStore;
	messageStore: MessageStore;
	loop: AgentLoop;
	cleanup: () => void;
} {
	const provider = new CapturingProvider();
	const messageStore = new MessageStore();
	const registry = new ToolRegistry();
	registry.register(readTool());
	const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-plan-ctx-'));
	const fileStore = new SessionFileStore('/Users/test/Plan Ctx', baseDir);
	const planMode = new SessionPlanModeStore(fileStore, new EventBus());
	const todoStore = new SessionTodoStore(fileStore);
	const loop = new AgentLoop(provider, messageStore, new ToolRouter(registry), registry, new EventBus(), {
		model: 'test-model',
		temperature: 0,
		maxTokens: 128,
		maxSteps: 3,
		workspaceRoots: [],
		todoStore,
		planModeStore: planMode,
	});
	return {
		provider,
		planMode,
		todoStore,
		messageStore,
		loop,
		cleanup: () => fs.rmSync(baseDir, { recursive: true, force: true }),
	};
}

describe('AgentLoop Plan 规划上下文', () => {
	it('planning 阶段临时注入规划指令，但不写入会话历史', async () => {
		const { provider, planMode, messageStore, loop, cleanup } = setup();
		try {
			planMode.transition('s1', 'planning');
			await loop.run('s1', '帮我规划');
			const requestMessages = provider.requests[0].messages;
			assert.ok(requestMessages.some((m) => m.role === 'system' && m.content.includes('Plan Mode')));
			const historyContents = messageStore.loadHistory('s1').map((m) => 'content' in m ? m.content : '');
			assert.ok(!historyContents.some((c) => c.includes('Plan Mode')));
		} finally {
			cleanup();
		}
	});

	it('普通模式不注入规划指令', async () => {
		const { provider, loop, cleanup } = setup();
		try {
			await loop.run('s1', '普通问题');
			const requestMessages = provider.requests[0].messages;
			assert.ok(!requestMessages.some((m) => m.role === 'system' && m.content.includes('Plan Mode')));
		} finally {
			cleanup();
		}
	});

	it('planning 阶段抑制"继续执行活跃任务"恢复提示', async () => {
		const { provider, planMode, todoStore, loop, cleanup } = setup();
		try {
			todoStore.write('s1', [{ id: 'old', content: '旧任务', status: 'in_progress' }]);
			planMode.transition('s1', 'planning');
			await loop.run('s1', '调研');
			const requestMessages = provider.requests[0].messages;
			assert.ok(!requestMessages.some((m) => m.content.includes('继续执行这些未完成任务')));
		} finally {
			cleanup();
		}
	});

	it('normal 阶段保留活跃任务恢复提示', async () => {
		const { provider, todoStore, loop, cleanup } = setup();
		try {
			todoStore.write('s1', [{ id: 'old', content: '旧任务', status: 'in_progress' }]);
			await loop.run('s1', '继续');
			const requestMessages = provider.requests[0].messages;
			assert.ok(requestMessages.some((m) => m.content.includes('继续执行这些未完成任务')));
		} finally {
			cleanup();
		}
	});
});
