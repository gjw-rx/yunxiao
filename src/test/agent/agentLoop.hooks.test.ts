/**
 * AgentLoop Hooks 集成测试：覆盖 session_start / session_end 事件配对
 * （正常完成、LLM 错误、中断三条路径）。
 */
import * as assert from 'assert';
import { AgentLoop } from '../../agent/agentLoop';
import { EventBus } from '../../core/eventBus';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import type { LLMEvent, LLMProvider, LLMRequest } from '../../llm/types';
import { MessageStore } from '../../memory/messageStore';
import { HookManager } from '../../hook/hookManager';
import type { HooksConfig, HooksConfigReader, SessionHookPayload } from '../../hook/types';

/** 内存 Hooks 配置读取器。 */
class MemoryConfig implements HooksConfigReader {
	constructor(private config: HooksConfig = { version: 1, enabled: true, rtk: { enabled: false } }) {}
	get(): HooksConfig {
		return this.config;
	}
}

/** 记录 session 事件的 Handler。 */
class SessionRecorder {
	readonly starts: SessionHookPayload[] = [];
	readonly ends: SessionHookPayload[] = [];
	register(manager: HookManager): void {
		manager.register({
			id: 'test-session-recorder',
			event: 'session_start',
			kind: 'guard',
			priority: 0,
			timeoutMs: 1000,
			handle: async (payload) => {
				this.starts.push(payload as SessionHookPayload);
				return { kind: 'pass' };
			},
		});
		manager.register({
			id: 'test-session-recorder-end',
			event: 'session_end',
			kind: 'guard',
			priority: 0,
			timeoutMs: 1000,
			handle: async (payload) => {
				this.ends.push(payload as SessionHookPayload);
				return { kind: 'pass' };
			},
		});
	}
}

/** 正常完成：返回最终文本后结束。 */
class NormalProvider implements LLMProvider {
	async *chatCompletion(): AsyncGenerator<LLMEvent> {
		yield { type: 'textDelta', text: '完成' };
		yield { type: 'finish', reason: 'stop' };
	}
}

/** LLM 返回错误。 */
class ErrorProvider implements LLMProvider {
	async *chatCompletion(): AsyncGenerator<LLMEvent> {
		yield { type: 'error', error: 'provider exploded' };
	}
}

/** 抛出异常。 */
class ThrowProvider implements LLMProvider {
	async *chatCompletion(): AsyncGenerator<LLMEvent> {
		throw new Error('unexpected failure');
	}
}

/** 构造 AgentLoop（注入 hooks）。 */
function makeLoop(provider: LLMProvider, manager: HookManager): AgentLoop {
	return new AgentLoop(provider, new MessageStore(), new ToolRouter(new ToolRegistry()), new ToolRegistry(), new EventBus(), {
		model: 'test-model',
		temperature: 0,
		maxTokens: 128,
		maxSteps: 3,
		workspaceRoots: ['/ws'],
		hooks: manager,
	});
}

describe('AgentLoop session 事件', () => {
	it('正常运行派发一次 session_start 与一次 session_end（载荷仅元数据）', async () => {
		const manager = new HookManager(new MemoryConfig());
		const recorder = new SessionRecorder();
		recorder.register(manager);
		const loop = makeLoop(new NormalProvider(), manager);
		await loop.run('s1', '你好');
		assert.strictEqual(recorder.starts.length, 1);
		assert.strictEqual(recorder.ends.length, 1);
		assert.strictEqual(recorder.starts[0].sessionId, 's1');
		assert.strictEqual(recorder.starts[0].runId, recorder.ends[0].runId);
		assert.deepStrictEqual(recorder.starts[0].workspaceRoots, ['/ws']);
		assert.deepStrictEqual(recorder.ends[0].workspaceRoots, ['/ws']);
		assert.ok(!('messages' in recorder.starts[0])); // 不含完整会话历史
	});

	it('LLM 返回错误时仍配对派发 session_end', async () => {
		const manager = new HookManager(new MemoryConfig());
		const recorder = new SessionRecorder();
		recorder.register(manager);
		const loop = makeLoop(new ErrorProvider(), manager);
		await loop.run('s2', '你好');
		assert.strictEqual(recorder.starts.length, 1);
		assert.strictEqual(recorder.ends.length, 1);
		assert.strictEqual(recorder.starts[0].runId, recorder.ends[0].runId);
	});

	it('未捕获异常时仍配对派发 session_end', async () => {
		const manager = new HookManager(new MemoryConfig());
		const recorder = new SessionRecorder();
		recorder.register(manager);
		const loop = makeLoop(new ThrowProvider(), manager);
		await loop.run('s3', '你好');
		assert.strictEqual(recorder.starts.length, 1);
		assert.strictEqual(recorder.ends.length, 1);
	});

	it('未装配 hooks 时运行不受影响', async () => {
		const loop = makeLoop(new NormalProvider(), new HookManager(new MemoryConfig()));
		// 未注入 hooks（makeLoop 已注入；此处直接构造不带 hooks 的 loop）
		const plain = new AgentLoop(new NormalProvider(), new MessageStore(), new ToolRouter(new ToolRegistry()), new ToolRegistry(), new EventBus(), {
			model: 'test-model',
			temperature: 0,
			maxTokens: 128,
			maxSteps: 3,
			workspaceRoots: ['/ws'],
		});
		await plain.run('s4', '你好');
		await loop.run('s5', '你好');
		assert.ok(true); // 不抛异常即通过
	});
});
