/**
 * ToolRegistry owner-scoped 动态注册测试（任务 9.1）。
 *
 * 覆盖 spec「动态 ToolRegistry」「owner-scoped 注册/替换/下线」场景：
 * - 静态工具与 owner 工具共存
 * - owner 注册工具
 * - 跨 owner 同名冲突
 * - 原子替换失败回滚
 * - owner 下线（unregisterOwner）后工具不可见
 * - list() 返回一致快照
 */
import * as assert from 'assert';
import { ToolRegistry } from '../../core/toolRegistry';
import { BaseTool, requireStringArg, type ToolContext, type ToolExecutionResult } from '../../tools/baseTool';
import { ToolNotFoundError } from '../../core/errors';
import type { ToolSchema } from '../../core/types';

/** 测试用只读工具。 */
class FakeReadTool extends BaseTool {
	readonly schema: ToolSchema;
	constructor(name: string, description = 'fake read') {
		super();
		this.schema = {
			name,
			description,
			parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
			permissions: 'read',
		};
	}
	validate(args: Record<string, unknown>): void {
		requireStringArg(args, 'path');
	}
	async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
		return { status: 'success', result: `content of ${args.path}` };
	}
}

/** 测试用写工具。 */
class FakeWriteTool extends BaseTool {
	readonly schema: ToolSchema;
	constructor(name: string) {
		super();
		this.schema = {
			name,
			description: 'fake write',
			parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
			permissions: 'write',
		};
	}
	async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
		return { status: 'success', result: `wrote ${args.path}` };
	}
}

describe('ToolRegistry owner-scoped 动态注册（9.1）', () => {
	it('静态工具与 owner 工具共存', () => {
		const reg = new ToolRegistry();
		reg.register(new FakeReadTool('fs_read_file'));
		reg.registerOwnerTools('mcp-server-A', [new FakeReadTool('mcp__serverA__tool_0')]);

		assert.strictEqual(reg.has('fs_read_file'), true);
		assert.strictEqual(reg.has('mcp__serverA__tool_0'), true);
		assert.strictEqual(reg.list().length, 2);
	});

	it('owner 注册工具', () => {
		const reg = new ToolRegistry();
		const tools = [
			new FakeReadTool('mcp__srv__tool_0'),
			new FakeReadTool('mcp__srv__tool_1'),
		];
		reg.registerOwnerTools('srv', tools);

		assert.strictEqual(reg.has('mcp__srv__tool_0'), true);
		assert.strictEqual(reg.has('mcp__srv__tool_1'), true);
		assert.strictEqual(reg.lookup('mcp__srv__tool_0').schema.name, 'mcp__srv__tool_0');
		assert.strictEqual(reg.list().length, 2);
	});

	it('跨 owner 同名冲突', () => {
		const reg = new ToolRegistry();
		reg.registerOwnerTools('srv-A', [new FakeReadTool('mcp__shared__tool')]);

		assert.throws(
			() => reg.registerOwnerTools('srv-B', [new FakeReadTool('mcp__shared__tool')]),
			/已注册/,
		);
		// 冲突时 srv-B 的工具不应被注册
		assert.strictEqual(reg.list().length, 1);
	});

	it('原子替换：旧工具下线、新工具上线，失败回滚', () => {
		const reg = new ToolRegistry();
		reg.registerOwnerTools('srv', [
			new FakeReadTool('mcp__srv__tool_0'),
			new FakeReadTool('mcp__srv__tool_1'),
		]);
		assert.strictEqual(reg.list().length, 2);

		// 替换为新的工具集
		const newTools = [
			new FakeReadTool('mcp__srv__tool_0'),
			new FakeReadTool('mcp__srv__tool_2'),
		];
		reg.replaceOwnerTools('srv', newTools);

		assert.strictEqual(reg.has('mcp__srv__tool_0'), true);
		assert.strictEqual(reg.has('mcp__srv__tool_1'), false, '旧工具应下线');
		assert.strictEqual(reg.has('mcp__srv__tool_2'), true, '新工具应上线');
		assert.strictEqual(reg.list().length, 2);
	});

	it('原子替换失败回滚：与静态工具冲突时保持原有工具', () => {
		const reg = new ToolRegistry();
		reg.register(new FakeReadTool('fs_read_file'));
		reg.registerOwnerTools('srv', [new FakeReadTool('mcp__srv__tool_0')]);
		assert.strictEqual(reg.list().length, 2);

		// 替换时新工具名与静态工具冲突 → 应回滚
		assert.throws(
			() => reg.replaceOwnerTools('srv', [new FakeReadTool('fs_read_file')]),
			/已注册/,
		);
		// 回滚：srv 的原工具仍在
		assert.strictEqual(reg.has('mcp__srv__tool_0'), true, '回滚后原 owner 工具应保留');
		assert.strictEqual(reg.list().length, 2, '回滚后工具总数不变');
	});

	it('owner 下线：unregisterOwner 后工具不可见', () => {
		const reg = new ToolRegistry();
		reg.registerOwnerTools('srv', [
			new FakeReadTool('mcp__srv__tool_0'),
			new FakeReadTool('mcp__srv__tool_1'),
		]);
		assert.strictEqual(reg.list().length, 2);

		reg.unregisterOwner('srv');

		assert.strictEqual(reg.has('mcp__srv__tool_0'), false);
		assert.strictEqual(reg.has('mcp__srv__tool_1'), false);
		assert.strictEqual(reg.list().length, 0);
		assert.throws(() => reg.lookup('mcp__srv__tool_0'), ToolNotFoundError);
	});

	it('list() 返回一致快照（不受后续注册影响）', () => {
		const reg = new ToolRegistry();
		reg.registerOwnerTools('srv', [new FakeReadTool('mcp__srv__tool_0')]);
		const snapshot = reg.list();
		assert.strictEqual(snapshot.length, 1);

		// 后续注册不应影响已返回的快照
		reg.registerOwnerTools('srv2', [new FakeReadTool('mcp__srv2__tool_0')]);
		assert.strictEqual(snapshot.length, 1, '快照不应受后续注册影响');
		assert.strictEqual(reg.list().length, 2);
	});

	it('未注册的 owner 替换/下线不抛错（幂等）', () => {
		const reg = new ToolRegistry();
		// 未注册的 owner 替换不抛错
		assert.doesNotThrow(() => reg.replaceOwnerTools('nonexistent', [new FakeReadTool('mcp__new__tool')]));
		assert.strictEqual(reg.has('mcp__new__tool'), true);

		// 未注册的 owner 下线不抛错
		assert.doesNotThrow(() => reg.unregisterOwner('nonexistent'));
	});

	it('静态 register 仍兼容（不受 owner 机制影响）', () => {
		const reg = new ToolRegistry();
		reg.register(new FakeReadTool('fs_read_file'));
		assert.strictEqual(reg.has('fs_read_file'), true);
		assert.strictEqual(reg.list().length, 1);
		// 重复静态注册仍抛错
		assert.throws(() => reg.register(new FakeReadTool('fs_read_file')), /已注册/);
	});
});
