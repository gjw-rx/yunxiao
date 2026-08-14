/**
 * McpToolAdapter 测试（任务 9.3）。
 *
 * 覆盖 spec「MCP Tool Adapter」场景：
 * - schema：从 catalog entry 转换，name/description/parameters/permissions 正确
 * - 权限映射：readOnly→read、destructive→destructive、无 hint→execute
 * - Manager 路由：execute 调用 Manager.callTool，使用原始工具名和参数
 * - AbortSignal：AgentLoop signal 透传到 Connection
 * - Server unavailable：Manager 返回 error，Adapter 返回结构化 error
 * - result governance：MCP 结果经过 BaseTool.governResult 脱敏/截断
 */
import * as assert from 'assert';
import { McpToolAdapter, type McpToolAdapterManager } from '../../mcp/toolAdapter';
import type { McpToolCatalogEntry } from '../../mcp/types';
import type { ToolCall } from '../../core/types';
import type { ToolContext, ToolExecutionResult } from '../../tools/baseTool';

/** 最小 Manager mock，实现 McpToolAdapterManager 接口。 */
class MockManager implements McpToolAdapterManager {
	readonly calls: { serverId: string; nativeToolName: string; args: Record<string, unknown>; signal?: AbortSignal }[] = [];
	readonly result: ToolExecutionResult;
	readonly signal?: AbortSignal;

	constructor(result: ToolExecutionResult) {
		this.result = result;
	}

	async callTool(serverId: string, nativeToolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
		this.calls.push({ serverId, nativeToolName, args, signal });
		return this.result;
	}
}

/** 构造 catalog entry。 */
function entry(opts: { serverId?: string; nativeName?: string; exposedName?: string; description?: string; readOnly?: boolean; destructive?: boolean; openWorld?: boolean } = {}): McpToolCatalogEntry {
	const annotations = opts.readOnly !== undefined || opts.destructive !== undefined || opts.openWorld !== undefined
		? {
			readOnlyHint: opts.readOnly,
			destructiveHint: opts.destructive,
			openWorldHint: opts.openWorld,
		}
		: undefined;
	return {
		serverId: opts.serverId ?? 'srv',
		nativeToolName: opts.nativeName ?? 'tool_0',
		exposedName: opts.exposedName ?? 'mcp__srv__tool_0',
		description: opts.description ?? '测试工具',
		inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: [] },
		annotations,
	};
}

const CTX: ToolContext = { workspaceRoots: [] };

describe('McpToolAdapter（9.3）', () => {
	it('schema：从 catalog entry 转换，name/description/parameters 正确', () => {
		const e = entry({ description: '查询数据库' });
		const manager = new MockManager({ status: 'success', result: 'ok' });
		const adapter = new McpToolAdapter(e, manager);

		assert.strictEqual(adapter.schema.name, 'mcp__srv__tool_0');
		assert.ok(adapter.schema.description.includes('查询数据库'));
		assert.ok(adapter.schema.description.includes('[MCP/srv]'));
		assert.deepStrictEqual(adapter.schema.parameters, e.inputSchema);
	});

	it('权限映射：readOnly→read', () => {
		const e = entry({ readOnly: true });
		const manager = new MockManager({ status: 'success', result: 'ok' });
		const adapter = new McpToolAdapter(e, manager);

		assert.strictEqual(adapter.schema.permissions, 'read');
		assert.strictEqual(adapter.schema.canParallel, true);
	});

	it('权限映射：destructive→destructive', () => {
		const e = entry({ destructive: true });
		const manager = new MockManager({ status: 'success', result: 'ok' });
		const adapter = new McpToolAdapter(e, manager);

		assert.strictEqual(adapter.schema.permissions, 'destructive');
		assert.strictEqual(adapter.schema.canParallel, false);
	});

	it('权限映射：无 hint→execute', () => {
		const e = entry({});
		const manager = new MockManager({ status: 'success', result: 'ok' });
		const adapter = new McpToolAdapter(e, manager);

		assert.strictEqual(adapter.schema.permissions, 'execute');
		assert.strictEqual(adapter.schema.canParallel, false);
	});

	it('Manager 路由：execute 调用 Manager.callTool，使用原始工具名和参数', async () => {
		const e = entry({ serverId: 'db-srv', nativeName: 'query_db', exposedName: 'mcp__db-srv__query_db' });
		const manager = new MockManager({ status: 'success', result: 'query result' });
		const adapter = new McpToolAdapter(e, manager);

		const result = await adapter.execute({ sql: 'SELECT 1' }, CTX);

		assert.strictEqual(result.status, 'success');
		assert.strictEqual(result.result, 'query result');
		assert.strictEqual(manager.calls.length, 1);
		assert.strictEqual(manager.calls[0].serverId, 'db-srv');
		assert.strictEqual(manager.calls[0].nativeToolName, 'query_db');
		assert.deepStrictEqual(manager.calls[0].args, { sql: 'SELECT 1' });
	});

	it('AbortSignal：AgentLoop signal 透传到 Manager', async () => {
		const e = entry();
		const manager = new MockManager({ status: 'success', result: 'ok' });
		const adapter = new McpToolAdapter(e, manager);
		const controller = new AbortController();

		await adapter.execute({ input: 'test' }, { ...CTX, abortSignal: controller.signal });

		assert.ok(manager.calls[0].signal, 'signal 应透传到 Manager');
		assert.strictEqual(manager.calls[0].signal, controller.signal);
	});

	it('Server unavailable：Manager 返回 error，Adapter 原样返回', async () => {
		const e = entry();
		const manager = new MockManager({ status: 'error', result: 'MCP Server srv 不可用', metadata: { retryable: false } });
		const adapter = new McpToolAdapter(e, manager);

		const result = await adapter.execute({ input: 'test' }, CTX);

		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.result, 'MCP Server srv 不可用');
		assert.strictEqual(result.metadata?.retryable, false);
	});

	it('result governance：MCP 结果经过 governResult 脱敏/截断', async () => {
		const e = entry();
		// 包含疑似密钥的长文本（脱敏后仍超字符上限）
		const longText = 'api_key=sk-1234567890abcdef\n'.repeat(1500);
		const manager = new MockManager({ status: 'success', result: longText });
		const adapter = new McpToolAdapter(e, manager);

		const result = await adapter.execute({ input: 'test' }, CTX);

		assert.strictEqual(result.status, 'success');
		// 密钥应被脱敏
		assert.ok(!result.result!.includes('sk-1234567890abcdef'), '密钥应被脱敏');
		assert.ok(result.result!.includes('***'), '脱敏后应包含 ***');
		// 结果应被截断
		assert.ok(result.metadata?.truncated, '长结果应被截断');
	});
});
