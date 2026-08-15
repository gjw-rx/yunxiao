/**
 * HookManager 单元测试：覆盖四类事件顺序、优先级、超时隔离、显式阻断、
 * 合法转换、无效转换回退与总开关关闭跳过。
 */
import * as assert from 'assert';
import { HookManager } from '../../hook/hookManager';
import type {
	HookHandler,
	HookHandlerResult,
	HooksConfig,
	HooksConfigReader,
	PreToolCallHookPayload,
	SessionHookPayload,
} from '../../hook/types';

/** 内存 Hooks 配置读取器。 */
class MemoryConfig implements HooksConfigReader {
	constructor(private config: HooksConfig = { version: 1, enabled: true, rtk: { enabled: false } }) {}
	get(): HooksConfig {
		return this.config;
	}
	setEnabled(enabled: boolean): void {
		this.config = { ...this.config, enabled };
	}
}

/** 构造测试用 Handler。 */
function makeHandler(partial: Partial<HookHandler> & Pick<HookHandler, 'id' | 'event'>): HookHandler {
	return {
		kind: 'guard',
		priority: 100,
		timeoutMs: 1000,
		handle: async () => ({ kind: 'pass' }),
		...partial,
	};
}

const SESSION_PAYLOAD: SessionHookPayload = {
	sessionId: 's1',
	runId: 'r1',
	workspaceRoots: ['/ws'],
	startedAt: 0,
};

const PRE_PAYLOAD: PreToolCallHookPayload = {
	sessionId: 's1',
	runId: 'r1',
	tool: 'terminal_exec',
	callId: 'c1',
	args: { command: 'git status' },
	originalArgs: { command: 'git status' },
};

describe('HookManager', () => {
	it('同一事件按稳定优先级串行执行（数值小者先执行）', async () => {
		const config = new MemoryConfig();
		const manager = new HookManager(config);
		const order: string[] = [];
		manager.register(makeHandler({
			id: 'h-low',
			event: 'session_start',
			priority: 10,
			handle: async () => { order.push('h-low'); return { kind: 'pass' }; },
		}));
		manager.register(makeHandler({
			id: 'h-high',
			event: 'session_start',
			priority: 100,
			handle: async () => { order.push('h-high'); return { kind: 'pass' }; },
		}));
		const traces = await manager.dispatch('session_start', SESSION_PAYLOAD);
		assert.deepStrictEqual(order, ['h-low', 'h-high']);
		assert.strictEqual(traces.length, 2);
		assert.deepStrictEqual(traces.map((t) => t.outcome), ['pass', 'pass']);
	});

	it('四类事件均可派发且互不干扰', async () => {
		const config = new MemoryConfig();
		const manager = new HookManager(config);
		const seen: string[] = [];
		for (const event of ['session_start', 'session_end', 'pre_tool_call', 'post_tool_call'] as const) {
			manager.register(makeHandler({
				id: `h-${event}`,
				event,
				handle: async () => { seen.push(event); return { kind: 'pass' }; },
			}));
		}
		await manager.dispatch('session_start', SESSION_PAYLOAD);
		await manager.dispatch('session_end', SESSION_PAYLOAD);
		await manager.dispatchPreToolCall(PRE_PAYLOAD);
		await manager.dispatch('post_tool_call', {
			sessionId: 's1',
			runId: 'r1',
			tool: 'terminal_exec',
			callId: 'c1',
			result: { call_id: 'c1', status: 'success', result: 'ok' },
		});
		assert.deepStrictEqual(seen, ['session_start', 'session_end', 'pre_tool_call', 'post_tool_call']);
	});

	it('普通 dispatch 不处理 pre_tool_call（返回空轨迹）', async () => {
		const config = new MemoryConfig();
		const manager = new HookManager(config);
		manager.register(makeHandler({ id: 'h-pre', event: 'pre_tool_call' }));
		const traces = await manager.dispatch('pre_tool_call', PRE_PAYLOAD);
		assert.strictEqual(traces.length, 0);
	});

	it('Handler 超时被隔离：记录 timeout 轨迹并继续执行后续 Handler', async () => {
		const config = new MemoryConfig();
		const manager = new HookManager(config);
		const after: string[] = [];
		manager.register(makeHandler({
			id: 'h-slow',
			event: 'session_start',
			priority: 10,
			timeoutMs: 30,
			handle: async () => {
				await new Promise((resolve) => setTimeout(resolve, 300));
				return { kind: 'pass' };
			},
		}));
		manager.register(makeHandler({
			id: 'h-fast',
			event: 'session_start',
			priority: 20,
			handle: async () => { after.push('h-fast'); return { kind: 'pass' }; },
		}));
		const traces = await manager.dispatch('session_start', SESSION_PAYLOAD);
		assert.strictEqual(traces[0].outcome, 'timeout');
		assert.ok(traces[0].error?.includes('超时'));
		assert.deepStrictEqual(after, ['h-fast']); // 超时不阻断后续
	});

	it('Handler 异常被隔离：记录 error 轨迹，不向外抛出', async () => {
		const config = new MemoryConfig();
		const manager = new HookManager(config);
		manager.register(makeHandler({
			id: 'h-boom',
			event: 'session_start',
			handle: async () => { throw new Error('boom'); },
		}));
		const traces = await manager.dispatch('session_start', SESSION_PAYLOAD);
		assert.strictEqual(traces[0].outcome, 'error');
		assert.strictEqual(traces[0].error, 'boom');
	});

	it('Guard 显式阻断返回 blocked 与原因', async () => {
		const config = new MemoryConfig();
		const manager = new HookManager(config);
		manager.register(makeHandler({
			id: 'h-guard',
			event: 'pre_tool_call',
			handle: async () => ({ kind: 'block', reason: '策略禁止' }),
		}));
		const result = await manager.dispatchPreToolCall(PRE_PAYLOAD);
		assert.strictEqual(result.blocked, true);
		assert.strictEqual(result.reason, '策略禁止');
	});

	it('受信任转换器按优先级链式应用并记录转换轨迹', async () => {
		const config = new MemoryConfig();
		const manager = new HookManager(config);
		manager.register(makeHandler({
			id: 'h-t1',
			event: 'pre_tool_call',
			kind: 'transform',
			priority: 10,
			handle: async () => ({ kind: 'transform', args: { command: 'rtk git status' } }),
		}));
		manager.register(makeHandler({
			id: 'h-t2',
			event: 'pre_tool_call',
			kind: 'transform',
			priority: 20,
			handle: async () => ({ kind: 'transform', args: { command: 'rtk -v git status', cwd: '/ws' } }),
		}));
		const result = await manager.dispatchPreToolCall(PRE_PAYLOAD);
		assert.strictEqual(result.blocked, false);
		assert.deepStrictEqual(result.args, { command: 'rtk -v git status', cwd: '/ws' });
		assert.strictEqual(result.transforms.length, 2);
		assert.strictEqual(result.transforms[0].hookId, 'h-t1');
		assert.strictEqual(result.transforms[1].hookId, 'h-t2');
	});

	it('转换器异常/超时回退：保持当前参数并继续（fail-open）', async () => {
		const config = new MemoryConfig();
		const manager = new HookManager(config);
		manager.register(makeHandler({
			id: 'h-bad',
			event: 'pre_tool_call',
			kind: 'transform',
			handle: async () => { throw new Error('转换失败'); },
		}));
		const result = await manager.dispatchPreToolCall(PRE_PAYLOAD);
		assert.strictEqual(result.blocked, false);
		assert.deepStrictEqual(result.args, PRE_PAYLOAD.args); // 保留原始参数
		assert.strictEqual(result.transforms.length, 0);
	});

	it('转换器之后运行 Guard，Guard 看到转换后的参数', async () => {
		const config = new MemoryConfig();
		const manager = new HookManager(config);
		let guardSeenArgs: Record<string, unknown> | undefined;
		manager.register(makeHandler({
			id: 'h-transform',
			event: 'pre_tool_call',
			kind: 'transform',
			handle: async () => ({ kind: 'transform', args: { command: 'rtk git status' } }),
		}));
		manager.register(makeHandler({
			id: 'h-guard',
			event: 'pre_tool_call',
			kind: 'guard',
			handle: async (payload) => {
				guardSeenArgs = (payload as PreToolCallHookPayload).args;
				return { kind: 'pass' };
			},
		}));
		await manager.dispatchPreToolCall(PRE_PAYLOAD);
		assert.deepStrictEqual(guardSeenArgs, { command: 'rtk git status' });
	});

	it('非转换器返回 transform / 非守卫返回 block 均被忽略（记 error）', async () => {
		const config = new MemoryConfig();
		const manager = new HookManager(config);
		manager.register(makeHandler({
			id: 'h-guard-transform',
			event: 'pre_tool_call',
			kind: 'guard',
			handle: async () => ({ kind: 'transform', args: { command: 'x' } }),
		}));
		manager.register(makeHandler({
			id: 'h-transform-block',
			event: 'pre_tool_call',
			kind: 'transform',
			handle: async () => ({ kind: 'block', reason: 'x' }),
		}));
		const result = await manager.dispatchPreToolCall(PRE_PAYLOAD);
		assert.strictEqual(result.blocked, false);
		assert.deepStrictEqual(result.args, PRE_PAYLOAD.args);
	});

	it('总开关关闭时跳过所有派发', async () => {
		const config = new MemoryConfig();
		config.setEnabled(false);
		const manager = new HookManager(config);
		let called = false;
		manager.register(makeHandler({
			id: 'h-any',
			event: 'session_start',
			handle: async () => { called = true; return { kind: 'pass' }; },
		}));
		const traces = await manager.dispatch('session_start', SESSION_PAYLOAD);
		assert.strictEqual(traces.length, 0);
		const pre = await manager.dispatchPreToolCall(PRE_PAYLOAD);
		assert.strictEqual(pre.blocked, false);
		assert.deepStrictEqual(pre.args, PRE_PAYLOAD.args);
		assert.strictEqual(called, false);
	});

	it('register 重复 ID 抛错，unregister 幂等', () => {
		const manager = new HookManager(new MemoryConfig());
		manager.register(makeHandler({ id: 'h1', event: 'session_start' }));
		assert.throws(() => manager.register(makeHandler({ id: 'h1', event: 'session_start' })));
		manager.unregister('h1');
		manager.unregister('h1'); // 幂等
		assert.strictEqual(manager.list().length, 0);
	});
});
