/**
 * ToolRouter Plan 模式兜底测试。
 * 验证 planning/review 阶段对 write/execute/destructive 工具在 Hook、审批与执行前
 * 返回 cancelled；明确只读的 MCP 工具可用，未声明只读（execute）的 MCP 工具被拒绝。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventBus } from '../../core/eventBus';
import { SessionPlanModeStore } from '../../core/planModeStore';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { SessionFileStore } from '../../memory/sessionFileStore';
import { BaseTool, requireStringArg, type ToolContext, type ToolExecutionResult } from '../../tools/baseTool';
import type { ToolCall, ToolSchema } from '../../core/types';

const CTX: ToolContext = { workspaceRoots: [], sessionId: 'sess-1' };

/** 测试用写工具：记录是否被执行。 */
class FakeWriteTool extends BaseTool {
	/** 已执行路径。 */
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

/** 测试用只读工具：记录是否被执行。 */
class FakeReadTool extends BaseTool {
	/** 已执行次数。 */
	executed = 0;
	readonly schema: ToolSchema = {
		name: 'fs_read_file',
		description: 'fake read',
		parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
		permissions: 'read',
	};
	async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
		this.executed++;
		return { status: 'success', result: `content of ${args.path}` };
	}
}

/** 构造指定权限的 MCP 风格工具。 */
function fakeMcpTool(name: string, permissions: ToolSchema['permissions']): BaseTool {
	return new (class extends BaseTool {
		readonly schema: ToolSchema = {
			name,
			description: 'fake mcp tool',
			parameters: { type: 'object', properties: {} },
			permissions,
		};
		async execute(): Promise<ToolExecutionResult> {
			return { status: 'success', result: 'ok' };
		}
	})();
}

/** 测试环境装配。 */
function setup(): { planMode: SessionPlanModeStore; cleanup: () => void } {
	const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-plan-router-'));
	const fileStore = new SessionFileStore('/Users/test/Plan Router', baseDir);
	const planMode = new SessionPlanModeStore(fileStore, new EventBus());
	return {
		planMode,
		cleanup: () => fs.rmSync(baseDir, { recursive: true, force: true }),
	};
}

describe('ToolRouter Plan 模式兜底', () => {
	it('planning 阶段 write 工具在审批前返回 cancelled 且不执行', async () => {
		const { planMode, cleanup } = setup();
		try {
			const reg = new ToolRegistry();
			const tool = new FakeWriteTool();
			reg.register(tool);
			let prompted = 0;
			const router = new ToolRouter(reg, {
				shouldGate: () => true,
				requestApproval: async () => { prompted++; return 'allow'; },
				requestDestructiveApproval: async () => { prompted++; return 'allow'; },
			} as never, undefined, undefined, undefined, planMode);
			planMode.transition('sess-1', 'planning');

			const result = await router.route(
				{ call_id: 'c1', tool: 'fs_write_file', args: { path: 'a.ts', content: 'x' } },
				CTX,
			);
			assert.strictEqual(result.status, 'cancelled');
			assert.ok(result.error?.includes('不允许'));
			assert.deepStrictEqual(tool.executed, []);
			assert.strictEqual(prompted, 0); // 未触发审批
		} finally {
			cleanup();
		}
	});

	it('review 阶段 destructive 工具被拒绝且无副作用', async () => {
		const { planMode, cleanup } = setup();
		try {
			const reg = new ToolRegistry();
			reg.register(fakeMcpTool('mcp__fs__delete', 'destructive'));
			const router = new ToolRouter(reg, undefined, undefined, undefined, undefined, planMode);
			planMode.transition('sess-1', 'planning');
			planMode.transition('sess-1', 'review');

			const result = await router.route(
				{ call_id: 'c2', tool: 'mcp__fs__delete', args: {} },
				CTX,
			);
			assert.strictEqual(result.status, 'cancelled');
		} finally {
			cleanup();
		}
	});

	it('明确只读的 MCP 工具在 planning 阶段可用', async () => {
		const { planMode, cleanup } = setup();
		try {
			const reg = new ToolRegistry();
			const tool = fakeMcpTool('mcp__web__search', 'read');
			reg.register(tool);
			const router = new ToolRouter(reg, undefined, undefined, undefined, undefined, planMode);
			planMode.transition('sess-1', 'planning');

			const result = await router.route(
				{ call_id: 'c3', tool: 'mcp__web__search', args: {} },
				CTX,
			);
			assert.strictEqual(result.status, 'success');
		} finally {
			cleanup();
		}
	});

	it('未声明只读（execute 权限）的 MCP 工具在 planning 阶段被拒绝', async () => {
		const { planMode, cleanup } = setup();
		try {
			const reg = new ToolRegistry();
			const tool = fakeMcpTool('mcp__db__query', 'execute');
			reg.register(tool);
			const router = new ToolRouter(reg, undefined, undefined, undefined, undefined, planMode);
			planMode.transition('sess-1', 'planning');

			const result = await router.route(
				{ call_id: 'c4', tool: 'mcp__db__query', args: {} },
				CTX,
			);
			assert.strictEqual(result.status, 'cancelled');
		} finally {
			cleanup();
		}
	});

	it('normal 阶段 write 工具不受 Plan 兜底影响', async () => {
		const { planMode, cleanup } = setup();
		try {
			const reg = new ToolRegistry();
			const tool = new FakeWriteTool();
			reg.register(tool);
			const router = new ToolRouter(reg, undefined, undefined, undefined, undefined, planMode);

			const result = await router.route(
				{ call_id: 'c5', tool: 'fs_write_file', args: { path: 'a.ts', content: 'x' } },
				CTX,
			);
			assert.strictEqual(result.status, 'success');
			assert.deepStrictEqual(tool.executed, ['a.ts']);
		} finally {
			cleanup();
		}
	});

	it('read 工具在 planning 阶段直通执行', async () => {
		const { planMode, cleanup } = setup();
		try {
			const reg = new ToolRegistry();
			const tool = new FakeReadTool();
			reg.register(tool);
			const router = new ToolRouter(reg, undefined, undefined, undefined, undefined, planMode);
			planMode.transition('sess-1', 'planning');

			const result = await router.route(
				{ call_id: 'c6', tool: 'fs_read_file', args: { path: 'a.ts' } },
				CTX,
			);
			assert.strictEqual(result.status, 'success');
			assert.strictEqual(tool.executed, 1);
		} finally {
			cleanup();
		}
	});
});
