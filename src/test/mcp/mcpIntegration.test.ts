/**
 * MCP stdio 服务集成测试 - 覆盖配置读取、工具代理与 JSON-RPC 通讯。
 */
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { McpServiceManager, parseMcpServerConfig } from '../../mcp/mcpServiceManager';
import { McpTool } from '../../mcp/mcpTool';
import { StdioMcpClient } from '../../mcp/stdioMcpClient';
import { ToolRegistry } from '../../core/toolRegistry';
import type { ToolContext } from '../../tools/baseTool';
import type { McpClient, McpToolDefinition } from '../../mcp/types';

/** 测试用 MCP 工具定义。 */
const REMOTE_TOOL: McpToolDefinition = {
	name: 'find_symbol',
	description: '查找代码符号',
	inputSchema: {
		type: 'object',
		properties: { query: { type: 'string' } },
		required: ['query'],
	},
};

/** 可记录调用的 MCP 客户端替身。 */
class FakeMcpClient implements McpClient {
	readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	closed = false;

	/** 建立连接。 */
	async connect(): Promise<void> {}

	/** 返回远程工具清单。 */
	async listTools(): Promise<readonly McpToolDefinition[]> {
		return [REMOTE_TOOL];
	}

	/** 调用远程工具。 */
	async callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }> {
		this.calls.push({ name, args });
		return { content: [{ type: 'text', text: 'symbol result' }] };
	}

	/** 关闭连接。 */
	async close(): Promise<void> {
		this.closed = true;
	}
}

describe('MCP 服务集成', () => {
	it('解析 codegraph 的 stdio 服务配置', () => {
		const configs = parseMcpServerConfig({
			mcpServers: {
				codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] },
			},
		});

		assert.deepStrictEqual(configs, [{ name: 'codegraph', command: 'codegraph', args: ['serve', '--mcp'] }]);
	});

	it('将远程工具注册为带服务前缀的本地代理并回传文本结果', async () => {
		const registry = new ToolRegistry();
		const client = new FakeMcpClient();
		const manager = new McpServiceManager(registry, () => client);

		await manager.initialize({ mcpServers: { codegraph: { type: 'stdio', command: 'codegraph' } } });
		const tool = registry.lookup('mcp_codegraph_find_symbol');
		const result = await tool.execute({ query: 'AgentLoop' }, {} as ToolContext);

		assert.strictEqual(tool.permission, 'execute');
		assert.strictEqual(result.status, 'success');
		assert.strictEqual(result.result, 'symbol result');
		assert.deepStrictEqual(client.calls, [{ name: 'find_symbol', args: { query: 'AgentLoop' } }]);
		await manager.dispose();
		assert.strictEqual(client.closed, true);
	});

	it('stdio 客户端完成 initialize、tools/list 与 tools/call 协议通讯', async () => {
		const serverScript = [
			"const readline = require('readline');",
			"readline.createInterface({ input: process.stdin }).on('line', (line) => {",
			"  const request = JSON.parse(line);",
			"  if (request.method === 'initialize') { console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } })); return; }",
			"  if (request.method === 'tools/list') { console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'find_symbol', description: '查找', inputSchema: { type: 'object' } }] } })); return; }",
			"  if (request.method === 'tools/call') { console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: request.params.arguments.query }] } })); }",
			"});",
		].join('\n');
		const client = new StdioMcpClient({ name: 'codegraph', command: process.execPath, args: ['-e', serverScript] });

		await client.connect();
		const tools = await client.listTools();
		const result = await client.callTool('find_symbol', { query: 'AgentLoop' });

		assert.strictEqual(tools[0].name, 'find_symbol');
		assert.deepStrictEqual(result, { content: [{ type: 'text', text: 'AgentLoop' }] });
		await client.close();
	});

	it('拒绝不支持的 MCP 传输类型', () => {
		assert.throws(
			() => parseMcpServerConfig({ mcpServers: { remote: { type: 'sse', url: 'https://example.com/mcp' } } }),
			/stdio/
		);
	});

	it('从工作区 .mcp.json 读取服务配置', async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-mcp-'));
		const configPath = path.join(tempDir, '.mcp.json');
		await fs.writeFile(configPath, JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command: 'codegraph' } } }));
		try {
			const registry = new ToolRegistry();
			const manager = new McpServiceManager(registry, () => new FakeMcpClient());
			await manager.initializeFromFile(configPath);
			assert.strictEqual(registry.has('mcp_codegraph_find_symbol'), true);
			await manager.dispose();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

/** 防止未使用导入被移除前失去对代理行为的直接覆盖。 */
void McpTool;
