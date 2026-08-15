import * as assert from 'assert';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { ApprovalGateway } from '../../core/approvalGateway';
import {
	BaseTool,
	requireStringArg,
	type ToolContext,
	type ToolExecutionResult,
} from '../../tools/baseTool';
import type { ToolCall, ToolSchema } from '../../core/types';
import { ToolExecutionJournal } from '../../core/toolExecutionJournal';
import type { WorkspaceState } from '../../core/toolExecutionJournal';

/** 测试用本地写工具：记录是否被执行。 */
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
		this.executed.push(args.path as string);
		return { status: 'success', result: `wrote ${args.path}` };
	}
}

const CTX: ToolContext = { workspaceRoots: [], sessionId: 'sess-1' };

class MemoryState implements WorkspaceState {
	private readonly values = new Map<string, unknown>();
	get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
	async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

describe('ToolRouter approval gating', () => {
	it('write 工具审批通过后执行', async () => {
		// Arrange
		const reg = new ToolRegistry();
		const tool = new FakeWriteTool();
		reg.register(tool);
		const gw = new ApprovalGateway({
			prompter: { prompt: async () => 'allow' },
			store: { getAlwaysAllow: () => [], addAlwaysAllow: async () => {} },
		});
		const router = new ToolRouter(reg, gw);
		const call: ToolCall = {
			call_id: 'c1',
			tool: 'fs_write_file',
			args: { path: 'a.ts', content: 'x' },
		};
		// Act
		const result = await router.route(call, CTX);
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.deepStrictEqual(tool.executed, ['a.ts']);
	});

	it('write 工具被拒绝返回 cancelled 且不执行', async () => {
		// Arrange
		const reg = new ToolRegistry();
		const tool = new FakeWriteTool();
		reg.register(tool);
		const gw = new ApprovalGateway({
			prompter: { prompt: async () => undefined }, // 拒绝
			store: { getAlwaysAllow: () => [], addAlwaysAllow: async () => {} },
		});
		const router = new ToolRouter(reg, gw);
		const call: ToolCall = {
			call_id: 'c2',
			tool: 'fs_write_file',
			args: { path: 'a.ts', content: 'x' },
		};
		// Act
		const result = await router.route(call, CTX);
		// Assert
		assert.strictEqual(result.status, 'cancelled');
		assert.ok(result.error?.includes('用户拒绝'));
		assert.deepStrictEqual(tool.executed, []); // 未执行
	});

	it('read 工具不触发审批', async () => {
		// Arrange
		const reg = new ToolRegistry();
		reg.register(
			new (class extends BaseTool {
				readonly schema: ToolSchema = {
					name: 'fs_read_file',
					description: 'fake read',
					parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
					permissions: 'read',
				};
				validate(args: Record<string, unknown>): void {
					requireStringArg(args, 'path');
				}
				async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
					return { status: 'success', result: `content of ${args.path}` };
				}
			})()
		);
		let prompted = false;
		const gw = new ApprovalGateway({
			prompter: { prompt: async () => { prompted = true; return 'allow'; } },
			store: { getAlwaysAllow: () => [], addAlwaysAllow: async () => {} },
		});
		const router = new ToolRouter(reg, gw);
		// Act
		const result = await router.route(
			{ call_id: 'c3', tool: 'fs_read_file', args: { path: 'a.ts' } },
			CTX
		);
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.strictEqual(prompted, false); // read 免审批
	});

	it('require_approval:false 仍 gate write（防御纵深）', async () => {
		// Arrange
		const reg = new ToolRegistry();
		const tool = new FakeWriteTool();
		reg.register(tool);
		const gw = new ApprovalGateway({
			prompter: { prompt: async () => undefined }, // 拒绝
			store: { getAlwaysAllow: () => [], addAlwaysAllow: async () => {} },
		});
		const router = new ToolRouter(reg, gw);
		const call: ToolCall = {
			call_id: 'c4',
			tool: 'fs_write_file',
			args: { path: 'a.ts', content: 'x' },
		};
		// Act
		const result = await router.route(call, CTX);
		// Assert
		assert.strictEqual(result.status, 'cancelled'); // 仍被本地 gate
		assert.deepStrictEqual(tool.executed, []);
	});

	it('无 approval 注入时向后兼容（Phase 1 行为）', async () => {
		// Arrange
		const reg = new ToolRegistry();
		const tool = new FakeWriteTool();
		reg.register(tool);
		const router = new ToolRouter(reg); // 无 gateway
		// Act
		const result = await router.route(
			{ call_id: 'c5', tool: 'fs_write_file', args: { path: 'a.ts', content: 'x' } },
			CTX
		);
		// Assert
		assert.strictEqual(result.status, 'success'); // 直通执行
		assert.deepStrictEqual(tool.executed, ['a.ts']);
	});

	it('复用已完成的副作用工具结果而不重复执行', async () => {
		const reg = new ToolRegistry();
		const tool = new FakeWriteTool();
		reg.register(tool);
		const router = new ToolRouter(reg, undefined, undefined, new ToolExecutionJournal(new MemoryState()));
		const call: ToolCall = { call_id: 'c6', tool: 'fs_write_file', args: { path: 'a.ts', content: 'x' } };
		const first = await router.route(call, { ...CTX, runId: 'run-1' });
		const second = await router.route(call, { ...CTX, runId: 'run-1' });
		assert.deepStrictEqual(second, first);
		assert.deepStrictEqual(tool.executed, ['a.ts']);
	});

	it('对未确认的副作用工具调用返回 unknown 且不重放', async () => {
		const reg = new ToolRegistry();
		const tool = new FakeWriteTool();
		reg.register(tool);
		const journal = new ToolExecutionJournal(new MemoryState());
		await journal.begin({ scopeId: 'run-1', callId: 'c7' }, 'fs_write_file');
		const router = new ToolRouter(reg, undefined, undefined, journal);
		const result = await router.route(
			{ call_id: 'c7', tool: 'fs_write_file', args: { path: 'a.ts', content: 'x' } },
			{ ...CTX, runId: 'run-1' },
		);
		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.metadata?.execution_state, 'unknown');
		assert.strictEqual(result.metadata?.retryable, false);
		assert.deepStrictEqual(tool.executed, []);
	});

	it('超时后的迟到结果保留 started 回执', async () => {
		const reg = new ToolRegistry();
		const tool = new (class extends FakeWriteTool {
			async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return super.execute(args);
			}
		})();
		reg.register(tool);
		const journal = new ToolExecutionJournal(new MemoryState());
		const router = new ToolRouter(reg, undefined, undefined, journal);
		const controller = new AbortController();
		const call: ToolCall = { call_id: 'c8', tool: 'fs_write_file', args: { path: 'a.ts', content: 'x' } };
		const pending = router.route(call, { ...CTX, runId: 'run-1', abortSignal: controller.signal });
		controller.abort();
		await pending;
		assert.deepStrictEqual(await journal.begin({ scopeId: 'run-1', callId: 'c8' }, 'fs_write_file'), { kind: 'unknown' });
	});

	it('execute 抛异常转结构化 error（无堆栈、不 rejects）', async () => {
		// Arrange
		const reg = new ToolRegistry();
		reg.register(
			new (class extends BaseTool {
				readonly schema: ToolSchema = { name: 'boom.tool', description: 'boom', parameters: {}, permissions: 'read' };
				async execute(): Promise<ToolExecutionResult> {
					throw new Error('boom');
				}
			})()
		);
		const router = new ToolRouter(reg);
		// Act
		const result = await router.route({ call_id: 'c9', tool: 'boom.tool', args: {} }, CTX);
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.error, 'boom');
		assert.ok(!result.error?.includes('at ')); // 不含堆栈
		assert.strictEqual(result.metadata?.retryable, false);
	});

	it('abort 后失败返回 cancelled 而非 error', async () => {
		// Arrange
		const reg = new ToolRegistry();
		reg.register(
			new (class extends BaseTool {
				readonly schema: ToolSchema = { name: 'abort.tool', description: 'abort', parameters: {}, permissions: 'read' };
				async execute(): Promise<ToolExecutionResult> {
					await new Promise((resolve) => setTimeout(resolve, 10));
					throw new Error('boom after abort');
				}
			})()
		);
		const router = new ToolRouter(reg);
		const controller = new AbortController();
		// Act
		const pending = router.route(
			{ call_id: 'c10', tool: 'abort.tool', args: {} },
			{ ...CTX, abortSignal: controller.signal }
		);
		controller.abort();
		const result = await pending;
		// Assert
		assert.strictEqual(result.status, 'cancelled');
		assert.ok(result.error?.includes('中断'));
	});
});
