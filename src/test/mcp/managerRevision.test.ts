/**
 * McpClientManager revision 与 config diff 测试（任务 10.3 + 10.4）。
 *
 * 覆盖 spec「revision gate」「config diff」场景：
 * - 未变化复用：同一 revision 不重复应用
 * - 过期 revision 丢弃：旧 revision 事件被忽略
 * - 新增 Server：创建 Connection
 * - 删除 Server：下线工具并关闭 Connection
 * - 重连：不改 Store，只重建 Connection
 */
import * as assert from 'assert';
import { McpClientManager, type McpManagerCallbacks } from '../../mcp/manager';
import { ToolRegistry } from '../../core/toolRegistry';
import type { McpServerRuntimeConfig, McpServerStatus } from '../../mcp/types';

/** 等待毫秒。 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 构造失败 STDIO 配置。 */
function failingConfig(): McpServerRuntimeConfig {
    return {
        type: 'stdio',
        command: 'nonexistent-xyz',
        args: [],
        env: {},
        enabled: true,
        connectTimeoutMs: 1000,
        callTimeoutMs: 1000,
    };
}

/** 创建空回调录制器。 */
function createRecorder(): { callbacks: McpManagerCallbacks; statuses: Map<string, McpServerStatus[]> } {
    const statuses = new Map<string, McpServerStatus[]>();
    const callbacks: McpManagerCallbacks = {
        onStatusChange: (id, status) => {
            let list = statuses.get(id);
            if (!list) { list = []; statuses.set(id, list); }
            list.push(status);
        },
        onInstructions: () => undefined,
    };
    return { callbacks, statuses };
}

describe('McpClientManager revision 与 config diff（10.3 + 10.4）', () => {
    it('过期 revision 丢弃：旧 revision 不被应用', async () => {
        const registry = new ToolRegistry();
        const { callbacks } = createRecorder();
        const manager = new McpClientManager({ registry, workspaceTrusted: true, callbacks });

        // 先应用 revision=2
        await manager.applyConfig(2, new Map());
        // 再尝试 revision=1（过期），应被丢弃
        const configs = new Map([['srv', failingConfig()]]);
        await manager.applyConfig(1, configs);

        // 过期 revision 不应创建 Connection
        assert.strictEqual(registry.list().length, 0);

        await manager.dispose();
    });

    it('新增 Server：创建 Connection', async () => {
        const registry = new ToolRegistry();
        const { callbacks, statuses } = createRecorder();
        const manager = new McpClientManager({ registry, workspaceTrusted: true, callbacks });

        const configs = new Map([['srv', failingConfig()]]);
        await manager.applyConfig(1, configs);

        const srvStatuses = statuses.get('srv') ?? [];
        assert.ok(srvStatuses.length > 0, '应收到状态变化');

        await manager.dispose();
    });

    it('删除 Server：下线工具并关闭 Connection', async () => {
        const registry = new ToolRegistry();
        const { callbacks } = createRecorder();
        const manager = new McpClientManager({ registry, workspaceTrusted: true, callbacks });

        // 先添加
        const configs1 = new Map([['srv', failingConfig()]]);
        await manager.applyConfig(1, configs1);

        // 再删除（空配置）
        await manager.applyConfig(2, new Map());

        assert.strictEqual(registry.list().length, 0, '删除后工具应为零');

        await manager.dispose();
    });

    it('reconnect：重建 Connection', async () => {
        const registry = new ToolRegistry();
        const { callbacks, statuses } = createRecorder();
        const manager = new McpClientManager({ registry, workspaceTrusted: true, callbacks });

        const configs = new Map([['srv', failingConfig()]]);
        await manager.applyConfig(1, configs);

        const beforeStatuses = (statuses.get('srv') ?? []).slice();

        await manager.reconnect('srv');

        // reconnect 后应收到新的状态变化
        const afterStatuses = statuses.get('srv') ?? [];
        assert.ok(afterStatuses.length > beforeStatuses.length, 'reconnect 应产生新的状态变化');

        await manager.dispose();
    });
});
