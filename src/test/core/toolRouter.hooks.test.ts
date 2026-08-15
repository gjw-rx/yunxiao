/**
 * ToolRouter Hooks 集成测试：覆盖 pre/post 工具事件、原始/最终参数双重审计、
 * 无效转换回退、Guard 阻断与结果治理后事件。
 */
import * as assert from 'assert';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { ApprovalGateway } from '../../core/approvalGateway';
import { HookManager } from '../../hook/hookManager';
import type {
	HookHandler,
	HooksConfig,
	HooksConfigReader,
	PostToolCallHookPayload,
} from '../../hook/types';
import {
	BaseTool,
	requireStringArg,
	type ToolContext,
	type ToolExecutionResult,
} from '../../tools/baseTool';
import type { ToolCall, ToolSchema } from '../../core/types';

/** 内存 Hooks 配置读取器。 */
class MemoryConfig implements HooksConfigReader {
	constructor(private config: HooksConfig = { version: 1, enabled: true, rtk: { enabled: false } }) {}
	get(): HooksConfig {
		return this.config;
	}
}

/** 测试用写工具：记录执行参数。 */
class FakeWriteTool extends BaseTool {
	readonly executed: string[] = [];
	readonly schema: ToolSchema = {
		name: 'fs_write_file',
		description: 'fake write',
		parameters: {
			type: 'object',
			properties: { path: { type: 'string' }, content: { type: 'string' } },
			required: ['path', 'content'],
		},
		permissions: 'write',
	};
	validate(args: Record<string, unknown>): void {
		requireStringArg(args, 'path');
		requireStringArg(args, 'content');
	}
	async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
		this.executed.push(JSON.stringify(args));
		return { status: 'success', result: `wrote ${args.path}` };
	}
}

/** 测试用只读工具：返回超长结果用于治理验证。 */
class FakeReadTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs_read_file',
		description: 'fake read',
		parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
		permissions: 'read',
	};
	async execute(): Promise<ToolExecutionResult> {
		return { status: 'success', result: 'x'.repeat(1000) };
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

const CTX: ToolContext = { workspaceRoots: ['/ws'], sessionId: 'sess-1', runId: 'run-1' };

/** 构造允许一切审批的 ToolRouter。 */
function makeRouter(registry: ToolRegistry, hooks?: HookManager): ToolRouter {
	const gw = new ApprovalGateway({
		prompter: { prompt: async () => 'allow' },
		store: { getAlwaysAllow: () => [], addAlwaysAllow: async () => {} },
	});
	return new ToolRouter(registry, gw, undefined, undefined, hooks);
}

describe('ToolRouter Hooks 集成', () => {
	it('pre_tool_call 转换后以最终参数执行，并派发 post_tool_call', async () => {
		const registry = new ToolRegistry();
		const tool = new FakeWriteTool();
		registry.register(tool);
		const manager = new HookManager(new MemoryConfig());
		manager.register(makeHandler({
			id: 'h-transform',
			event: 'pre_tool_call',
			kind: 'transform',
			handle: async () => ({ kind: 'transform', args: { path: 'b.ts', content: 'final' } }),
		}));
		const postCalls: PostToolCallHookPayload[] = [];
		manager.register(makeHandler({
			id: 'h-post',
			event: 'post_tool_call',
			handle: async (payload) => {
				postCalls.push(payload as PostToolCallHookPayload);
				return { kind: 'pass' };
			},
		}));
		const router = makeRouter(registry, manager);
		const result = await router.route(
			{ call_id: 'c1', tool: 'fs_write_file', args: { path: 'a.ts', content: 'x' } },
			CTX
		);
		assert.strictEqual(result.status, 'success');
		// 执行的是最终参数（转换后）
		assert.deepStrictEqual(tool.executed, [JSON.stringify({ path: 'b.ts', content: 'final' })]);
		// post_tool_call 已派发且结果匹配
		assert.strictEqual(postCalls.length, 1);
		assert.strictEqual(postCalls[0].tool, 'fs_write_file');
		assert.strictEqual(postCalls[0].result.status, 'success');
	});

	it('无效转换（违反 schema）保留原始参数执行', async () => {
		const registry = new ToolRegistry();
		const tool = new FakeWriteTool();
		registry.register(tool);
		const manager = new HookManager(new MemoryConfig());
		manager.register(makeHandler({
			id: 'h-bad-transform',
			event: 'pre_tool_call',
			kind: 'transform',
			// 缺 content，违反 schema
			handle: async () => ({ kind: 'transform', args: { path: 'b.ts' } }),
		}));
		const router = makeRouter(registry, manager);
		const result = await router.route(
			{ call_id: 'c2', tool: 'fs_write_file', args: { path: 'a.ts', content: 'x' } },
			CTX
		);
		assert.strictEqual(result.status, 'success');
		assert.deepStrictEqual(tool.executed, [JSON.stringify({ path: 'a.ts', content: 'x' })]);
	});

	it('Guard 显式阻断返回 cancelled 且不执行', async () => {
		const registry = new ToolRegistry();
		const tool = new FakeWriteTool();
		registry.register(tool);
		const manager = new HookManager(new MemoryConfig());
		manager.register(makeHandler({
			id: 'h-guard',
			event: 'pre_tool_call',
			kind: 'guard',
			handle: async () => ({ kind: 'block', reason: '策略禁止写入' }),
		}));
		const router = makeRouter(registry, manager);
		const result = await router.route(
			{ call_id: 'c3', tool: 'fs_write_file', args: { path: 'a.ts', content: 'x' } },
			CTX
		);
		assert.strictEqual(result.status, 'cancelled');
		assert.ok(result.error?.includes('策略禁止写入'));
		assert.deepStrictEqual(tool.executed, []);
	});

	it('原始参数违反集中审计时拒绝（转换后安全也不能绕过）', async () => {
		const registry = new ToolRegistry();
		const tool = new FakeWriteTool();
		registry.register(tool);
		const manager = new HookManager(new MemoryConfig());
		manager.register(makeHandler({
			id: 'h-transform',
			event: 'pre_tool_call',
			kind: 'transform',
			// 试图把越界路径改写成安全路径
			handle: async () => ({ kind: 'transform', args: { path: 'safe.ts', content: 'x' } }),
		}));
		const router = makeRouter(registry, manager);
		const result = await router.route(
			{ call_id: 'c4', tool: 'fs_write_file', args: { path: '../evil.ts', content: 'x' } },
			CTX
		);
		assert.strictEqual(result.status, 'error'); // 原始审计拒绝
		assert.ok(result.error?.includes('路径越界'));
		assert.deepStrictEqual(tool.executed, []);
	});

	it('最终参数违反集中审计时拒绝（审批不能放行）', async () => {
		const registry = new ToolRegistry();
		const tool = new FakeWriteTool();
		registry.register(tool);
		const manager = new HookManager(new MemoryConfig());
		manager.register(makeHandler({
			id: 'h-transform',
			event: 'pre_tool_call',
			kind: 'transform',
			// 把安全路径改写成越界路径
			handle: async () => ({ kind: 'transform', args: { path: '../evil.ts', content: 'x' } }),
		}));
		const router = makeRouter(registry, manager);
		const result = await router.route(
			{ call_id: 'c5', tool: 'fs_write_file', args: { path: 'safe.ts', content: 'x' } },
			CTX
		);
		assert.strictEqual(result.status, 'error'); // 最终审计拒绝
		assert.ok(result.error?.includes('路径越界'));
		assert.deepStrictEqual(tool.executed, []);
	});

	it('post_tool_call 看到的是治理后的结果（超长结果被截断）', async () => {
		const registry = new ToolRegistry();
		registry.register(new FakeReadTool());
		const manager = new HookManager(new MemoryConfig());
		let postResult: PostToolCallHookPayload | undefined;
		manager.register(makeHandler({
			id: 'h-post',
			event: 'post_tool_call',
			handle: async (payload) => {
				postResult = payload as PostToolCallHookPayload;
				return { kind: 'pass' };
			},
		}));
		const router = makeRouter(registry, manager);
		const result = await router.route(
			{ call_id: 'c6', tool: 'fs_read_file', args: { path: 'a.ts' } },
			{ ...CTX, governMaxBytes: 100, toolResultLimit: 100 }
		);
		assert.strictEqual(result.status, 'success');
		// 治理后结果被截断
		assert.ok((postResult?.result.result ?? '').includes('已裁剪'));
		assert.ok((postResult?.result.result ?? '').length < 1000);
	});

	it('Hook 篡改 payload.originalArgs 顶层字段不可绕过原始审计（深拷贝快照）', async () => {
		const registry = new ToolRegistry();
		const tool = new FakeWriteTool();
		registry.register(tool);
		const manager = new HookManager(new MemoryConfig());
		manager.register(makeHandler({
			id: 'h-tamper',
			event: 'pre_tool_call',
			kind: 'transform',
			// 直接修改 payload.originalArgs（而非通过 transform 返回）
			handle: async (payload) => {
				(payload as { originalArgs: Record<string, unknown> }).originalArgs.path = 'safe.ts';
				return { kind: 'pass' };
			},
		}));
		const router = makeRouter(registry, manager);
		const result = await router.route(
			{ call_id: 'c8', tool: 'fs_write_file', args: { path: '../evil.ts', content: 'x' } },
			CTX
		);
		// 原始审计在 Hook 执行前完成：篡改后的快照不影响审计结果
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('路径越界'));
		assert.deepStrictEqual(tool.executed, []);
	});

	it('无 Hook 注入时行为不变（向后兼容）', async () => {
		const registry = new ToolRegistry();
		const tool = new FakeWriteTool();
		registry.register(tool);
		const router = makeRouter(registry); // 无 hooks
		const result = await router.route(
			{ call_id: 'c7', tool: 'fs_write_file', args: { path: 'a.ts', content: 'x' } },
			CTX
		);
		assert.strictEqual(result.status, 'success');
		assert.deepStrictEqual(tool.executed, [JSON.stringify({ path: 'a.ts', content: 'x' })]);
	});
});
