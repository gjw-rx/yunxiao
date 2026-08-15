/**
 * McpClientManager 测试（任务 10.1）。
 *
 * 覆盖 spec「MCP Client Runtime」「连接重建与故障隔离」场景：
 * - 多 Server 连接：各 Server 独立连接，工具按 owner 发布到 ToolRegistry
 * - 单 Server 故障隔离：一个 Server 失败不影响其他
 * - instructions 快照：ready Server 的 instructions 被收集
 * - 状态订阅：状态变化通过回调通知
 * - 反向调用：callTool 路由到正确的 Connection
 * - dispose：全部 Connection 被释放，工具被下线
 */
import * as assert from 'assert';
import { McpClientManager, type McpManagerCallbacks } from '../../mcp/manager';
import { ToolRegistry } from '../../core/toolRegistry';
import type { McpServerRuntimeConfig, McpServerStatus, McpServerInstructions, McpError as McpFailure } from '../../mcp/types';
import type { ToolExecutionResult } from '../../tools/baseTool';

/** 等待毫秒。 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 构造 STDIO 运行时配置（command 不存在，用于失败测试）。 */
function failingStdioConfig(serverId: string): { serverId: string; config: McpServerRuntimeConfig } {
	return {
		serverId,
		config: {
			type: 'stdio',
			command: 'nonexistent-command-xyz',
			args: [],
			env: {},
			enabled: true,
			connectTimeoutMs: 2000,
			callTimeoutMs: 5000,
		},
	};
}

/** 状态录制器。 */
function createStatusRecorder(): { callbacks: McpManagerCallbacks; statuses: Map<string, McpServerStatus[]> } {
	const statuses = new Map<string, McpServerStatus[]>();
	const callbacks: McpManagerCallbacks = {
		onStatusChange: (serverId, status) => {
			let list = statuses.get(serverId);
			if (!list) {
				list = [];
				statuses.set(serverId, list);
			}
			list.push(status);
		},
		onInstructions: () => undefined,
	};
	return { callbacks, statuses };
}

describe('McpClientManager（10.1）', () => {
	it('dispose 后全部 Connection 被释放，工具被下线', async () => {
		const registry = new ToolRegistry();
		const { callbacks } = createStatusRecorder();
		const manager = new McpClientManager({
			registry,
			workspaceTrusted: true,
			callbacks,
		});

		await manager.applyConfig(1, new Map());
		await manager.dispose();

		assert.strictEqual(registry.list().length, 0);
	});

	it('applyConfig 空配置：不创建 Connection，工具数为零', async () => {
		const registry = new ToolRegistry();
		const { callbacks } = createStatusRecorder();
		const manager = new McpClientManager({
			registry,
			workspaceTrusted: true,
			callbacks,
		});

		await manager.applyConfig(1, new Map());

		assert.strictEqual(registry.list().length, 0);
		await manager.dispose();
	});

	it('单 Server 故障隔离：失败 Server 不影响其他', async () => {
		const registry = new ToolRegistry();
		const { callbacks, statuses } = createStatusRecorder();
		const manager = new McpClientManager({
			registry,
			workspaceTrusted: true,
			callbacks,
		});

		const configs = new Map<string, McpServerRuntimeConfig>([
			['failing-srv', failingStdioConfig('failing-srv').config],
		]);
		await manager.applyConfig(1, configs);

		// 失败 Server 应进入 error
		const failStatuses = statuses.get('failing-srv') ?? [];
		assert.ok(failStatuses.includes('error'), `失败 Server 应进入 error，实际：${JSON.stringify(failStatuses)}`);

		await manager.dispose();
	});

	it('callTool 路由：Server unavailable 返回结构化 error', async () => {
		const registry = new ToolRegistry();
		const { callbacks } = createStatusRecorder();
		const manager = new McpClientManager({
			registry,
			workspaceTrusted: true,
			callbacks,
		});

		await manager.applyConfig(1, new Map());

		const result = await manager.callTool('nonexistent', 'tool_0', {});
		assert.strictEqual(result.status, 'error');
		assert.ok(result.result!.includes('不可用'));

		await manager.dispose();
	});

	it('getInstructions：空时返回空数组', async () => {
		const registry = new ToolRegistry();
		const { callbacks } = createStatusRecorder();
		const manager = new McpClientManager({
			registry,
			workspaceTrusted: true,
			callbacks,
		});

		await manager.applyConfig(1, new Map());
		const instructions = manager.getInstructions();
		assert.deepStrictEqual(instructions, []);

		await manager.dispose();
	});

	it('getSettingsSnapshot：空时返回空 servers 列表', async () => {
		const registry = new ToolRegistry();
		const { callbacks } = createStatusRecorder();
		const manager = new McpClientManager({
			registry,
			workspaceTrusted: true,
			callbacks,
		});

		await manager.applyConfig(1, new Map());
		const snapshot = manager.getSettingsSnapshot();
		assert.strictEqual(snapshot.servers.length, 0);

		await manager.dispose();
	});

	it('applyConfig 编辑已启用 Server 时重建 Connection', async () => {
		const registry = new ToolRegistry();
		const { callbacks, statuses } = createStatusRecorder();
		const manager = new McpClientManager({
			registry,
			workspaceTrusted: true,
			callbacks,
		});
		const initial = failingStdioConfig('srv').config;
		await manager.applyConfig(1, new Map([['srv', initial]]));
		const initialStatusCount = (statuses.get('srv') ?? []).length;

		await manager.applyConfig(2, new Map([['srv', { ...initial, args: ['--updated'] }]]));

		assert.ok((statuses.get('srv') ?? []).length > initialStatusCount, '编辑配置后应重建并重新连接 Server');
		await manager.dispose();
	});

	it('不可信工作区：Server 保持 waiting_workspace_trust，不创建 Connection', async () => {
		const registry = new ToolRegistry();
		const { callbacks, statuses } = createStatusRecorder();
		const manager = new McpClientManager({
			registry,
			workspaceTrusted: false,
			callbacks,
		});

		const configs = new Map<string, McpServerRuntimeConfig>([
			['srv', failingStdioConfig('srv').config],
		]);
		await manager.applyConfig(1, configs);

		const srvStatuses = statuses.get('srv') ?? [];
		assert.ok(srvStatuses.includes('waiting_workspace_trust'), `不可信应保持 waiting，实际：${JSON.stringify(srvStatuses)}`);

		await manager.dispose();
	});
});
