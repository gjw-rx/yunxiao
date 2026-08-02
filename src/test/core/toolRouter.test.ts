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

/** 测试用本地写工具：记录是否被执行。 */
class FakeWriteTool extends BaseTool {
	readonly executed: string[] = [];
	readonly schema: ToolSchema = {
		name: 'fs.write_file',
		description: 'fake write',
		parameters: {
			type: 'object',
			properties: { path: { type: 'string' }, content: { type: 'string' } },
			required: ['path', 'content'],
		},
		permissions: 'write',
		site: 'local',
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
			tool: 'fs.write_file',
			args: { path: 'a.ts', content: 'x' },
			site: 'local',
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
			tool: 'fs.write_file',
			args: { path: 'a.ts', content: 'x' },
			site: 'local',
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
					name: 'fs.read_file',
					description: 'fake read',
					parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
					permissions: 'read',
					site: 'local',
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
			{ call_id: 'c3', tool: 'fs.read_file', args: { path: 'a.ts' }, site: 'local' },
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
			tool: 'fs.write_file',
			args: { path: 'a.ts', content: 'x' },
			site: 'local',
			require_approval: false, // 云端未置位
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
			{ call_id: 'c5', tool: 'fs.write_file', args: { path: 'a.ts', content: 'x' }, site: 'local' },
			CTX
		);
		// Assert
		assert.strictEqual(result.status, 'success'); // 直通执行
		assert.deepStrictEqual(tool.executed, ['a.ts']);
	});
});
