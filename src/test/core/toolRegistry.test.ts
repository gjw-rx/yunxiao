import * as assert from 'assert';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { BaseTool, requireStringArg, type ToolContext, type ToolExecutionResult } from '../../tools/baseTool';
import { ToolNotFoundError } from '../../core/errors';
import type { ToolCall, ToolSchema } from '../../core/types';

/** 测试用本地只读工具：回显读取的 path。 */
class FakeReadTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs_read_file',
		description: 'fake read',
		parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
		permissions: 'read',
	};
	validate(args: Record<string, unknown>): void {
		requireStringArg(args, 'path');
	}
	async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
		return { status: 'success', result: `content of ${args.path}` };
	}
}

/** 测试用云端工具：本地不应执行。 */
class FakeCloudTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'kb.search',
		description: 'fake cloud',
		parameters: { type: 'object', properties: { q: { type: 'string' } } },
		permissions: 'read',
	};
	async execute(): Promise<ToolExecutionResult> {
		return { status: 'success', result: 'should-not-run-locally' };
	}
}

const CTX: ToolContext = { workspaceRoots: [] };

describe('ToolRegistry', () => {
	it('registers and looks up a tool', () => {
		const reg = new ToolRegistry();
		reg.register(new FakeReadTool());
		const tool = reg.lookup('fs_read_file');
		assert.strictEqual(tool.schema.name, 'fs_read_file');
		assert.strictEqual(reg.has('fs_read_file'), true);
	});

	it('rejects duplicate registration', () => {
		const reg = new ToolRegistry();
		reg.register(new FakeReadTool());
		assert.throws(() => reg.register(new FakeReadTool()), /已注册/);
	});

	it('throws ToolNotFoundError for unknown tool', () => {
		const reg = new ToolRegistry();
		assert.throws(() => reg.lookup('fs_nonexistent'), ToolNotFoundError);
	});

	it('lists all schemas', () => {
		const reg = new ToolRegistry();
		reg.register(new FakeReadTool());
		reg.register(new FakeCloudTool());
		assert.strictEqual(reg.list().length, 2);
	});
});

describe('ToolRouter', () => {
	it('routes and executes a local tool call, stamping tool_call_id', async () => {
		const reg = new ToolRegistry();
		reg.register(new FakeReadTool());
		const router = new ToolRouter(reg);
		const call: ToolCall = {
			call_id: 'c1',
			tool: 'fs_read_file',
			args: { path: 'a.ts' },
		};
		const result = await router.route(call, CTX);
		assert.strictEqual(result.call_id, 'c1');
		assert.strictEqual(result.status, 'success');
		assert.strictEqual(result.result, 'content of a.ts');
	});

	it('未注册工具返回结构化 error（不抛未捕获异常）', async () => {
		const router = new ToolRouter(new ToolRegistry());
		const call: ToolCall = {
			call_id: 'c3',
			tool: 'fs_missing',
			args: {},
		};
		const result = await router.route(call, CTX);
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('未找到工具'));
		assert.strictEqual(result.metadata?.retryable, false);
	});

	it('参数校验失败返回结构化 error（含重写指导文案）', async () => {
		const reg = new ToolRegistry();
		reg.register(new FakeReadTool());
		const router = new ToolRouter(reg);
		const call: ToolCall = {
			call_id: 'c4',
			tool: 'fs_read_file',
			args: {},
		};
		const result = await router.route(call, CTX);
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('缺少必填参数'));
		assert.ok(result.error?.includes('rewrite the input'));
		assert.strictEqual(result.metadata?.retryable, false);
	});
});
