/**
 * ToolRouter MCP 工具审批测试（任务 9.5）。
 *
 * 覆盖 spec「ToolRouter 与 MCP 工具」场景：
 * - read 免审批：readOnly MCP 工具直通执行
 * - unknown→execute 审批：无 hint 的 MCP 工具走审批门
 * - destructive 审批：destructive MCP 工具走 destructive 审批
 * - 拒绝时 Manager 不收到请求：审批被拒后 Manager.callTool 不被调用
 */
import * as assert from 'assert';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { McpToolAdapter, type McpToolAdapterManager } from '../../mcp/toolAdapter';
import type { McpToolCatalogEntry } from '../../mcp/types';
import type { ToolCall } from '../../core/types';
import type { ToolContext, ToolExecutionResult } from '../../tools/baseTool';
import { ApprovalGateway, type ApprovalDecision, type ApprovalPrompter, type ApprovalConfigStore } from '../../core/approvalGateway';

/** 追踪调用次数的 Manager mock。 */
class TrackingManager implements McpToolAdapterManager {
	readonly calls: { serverId: string; nativeToolName: string }[] = [];
	readonly result: ToolExecutionResult;

	constructor(result: ToolExecutionResult = { status: 'success', result: 'ok' }) {
		this.result = result;
	}

	async callTool(serverId: string, nativeToolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
		this.calls.push({ serverId, nativeToolName });
		return this.result;
	}
}

/** 构造 catalog entry。 */
function entry(name: string, opts: { readOnly?: boolean; destructive?: boolean } = {}): McpToolCatalogEntry {
	return {
		serverId: 'srv',
		nativeToolName: name,
		exposedName: `mcp__srv__${name}`,
		description: `测试工具 ${name}`,
		inputSchema: { type: 'object', properties: {}, required: [] },
		annotations: opts.readOnly !== undefined || opts.destructive !== undefined
			? { readOnlyHint: opts.readOnly, destructiveHint: opts.destructive }
			: undefined,
	};
}

const CTX: ToolContext = { workspaceRoots: [] };

/** 创建返回固定决策的 ApprovalGateway。 */
function fixedApprovalGateway(decision: ApprovalDecision): ApprovalGateway {
	const prompter: ApprovalPrompter = {
		async prompt(): Promise<ApprovalDecision | undefined> {
			return decision;
		},
	};
	const store: ApprovalConfigStore = {
		getAlwaysAllow: () => [],
		addAlwaysAllow: async () => undefined,
		getScopedApprovals: () => [],
		addScopedApproval: async () => undefined,
		getApprovalMode: () => 'request',
		setApprovalMode: async () => undefined,
	};
	return new ApprovalGateway({ prompter, store });
}

describe('ToolRouter MCP 工具审批（9.5）', () => {
	it('read 免审批：readOnly MCP 工具直通执行', async () => {
		const manager = new TrackingManager();
		const reg = new ToolRegistry();
		reg.registerOwnerTools('srv', [
			new McpToolAdapter(entry('read_tool', { readOnly: true }), manager),
		]);
		// 即使有 ApprovalGateway 设为 deny，read 工具应直通
		const router = new ToolRouter(reg, fixedApprovalGateway('deny'));
		const call: ToolCall = { call_id: 'c1', tool: 'mcp__srv__read_tool', args: {} };

		const result = await router.route(call, CTX);

		assert.strictEqual(result.status, 'success');
		assert.strictEqual(manager.calls.length, 1, 'read 工具应直通执行');
	});

	it('unknown→execute 审批：无 hint 的 MCP 工具走审批门', async () => {
		const manager = new TrackingManager();
		const reg = new ToolRegistry();
		reg.registerOwnerTools('srv', [
			new McpToolAdapter(entry('exec_tool'), manager),
		]);
		const router = new ToolRouter(reg, fixedApprovalGateway('allow'));
		const call: ToolCall = { call_id: 'c2', tool: 'mcp__srv__exec_tool', args: {} };

		const result = await router.route(call, CTX);

		assert.strictEqual(result.status, 'success');
		assert.strictEqual(manager.calls.length, 1, '审批通过后应执行');
	});

	it('destructive 审批：destructive MCP 工具走 destructive 审批', async () => {
		const manager = new TrackingManager();
		const reg = new ToolRegistry();
		reg.registerOwnerTools('srv', [
			new McpToolAdapter(entry('del_tool', { destructive: true }), manager),
		]);
		const router = new ToolRouter(reg, fixedApprovalGateway('allow'));
		const call: ToolCall = { call_id: 'c3', tool: 'mcp__srv__del_tool', args: {} };

		const result = await router.route(call, CTX);

		assert.strictEqual(result.status, 'success');
		assert.strictEqual(manager.calls.length, 1, 'destructive 审批通过后应执行');
	});

	it('拒绝时 Manager 不收到请求：审批被拒后 Manager.callTool 不被调用', async () => {
		const manager = new TrackingManager();
		const reg = new ToolRegistry();
		reg.registerOwnerTools('srv', [
			new McpToolAdapter(entry('exec_tool'), manager),
		]);
		const router = new ToolRouter(reg, fixedApprovalGateway('deny'));
		const call: ToolCall = { call_id: 'c4', tool: 'mcp__srv__exec_tool', args: {} };

		const result = await router.route(call, CTX);

		assert.strictEqual(result.status, 'cancelled');
		assert.strictEqual(manager.calls.length, 0, '拒绝时 Manager 不应收到请求');
	});
});
