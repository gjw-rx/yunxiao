/**
 * MCP SDK 导入路径最小验证测试。
 *
 * 职责：验证官方 Client 与三类 Transport（STDIO / Streamable HTTP / SSE）的
 * 导入路径在 VS Code Extension Host（Node 20）运行时可解析、可构造。
 * 该测试比 esbuild 打包更严格——能在真实 Node 运行时加载，esbuild 必然可打包。
 */
import * as assert from 'assert';
import { Client, StdioClientTransport, StreamableHTTPClientTransport, SSEClientTransport } from '../../mcp/sdk';

describe('MCP SDK 导入路径', () => {
	it('Client 与三类 Transport 均为可构造函数', () => {
		// Client 构造函数
		assert.strictEqual(typeof Client, 'function', 'Client 必须可构造');
		// 三类 Transport 构造函数
		assert.strictEqual(typeof StdioClientTransport, 'function', 'StdioClientTransport 必须可构造');
		assert.strictEqual(typeof StreamableHTTPClientTransport, 'function', 'StreamableHTTPClientTransport 必须可构造');
		assert.strictEqual(typeof SSEClientTransport, 'function', 'SSEClientTransport 必须可构造');
	});

	it('Client 可用最小参数实例化', () => {
		// 验证 Client 构造签名匹配：接受 { name, version } 实现信息
		const client = new Client({ name: 'yunxiao-agent-test', version: '0.0.0' });
		assert.ok(client, 'Client 实例化必须成功');
		assert.strictEqual(typeof client.connect, 'function', 'Client 必须暴露 connect 方法');
		assert.strictEqual(typeof client.close, 'function', 'Client 必须暴露 close 方法');
		assert.strictEqual(typeof client.listTools, 'function', 'Client 必须暴露 listTools 方法');
		assert.strictEqual(typeof client.callTool, 'function', 'Client 必须暴露 callTool 方法');
	});

	it('STDIO Transport 可用最小参数实例化', () => {
		// 验证 StdioClientTransport 构造签名：接受 { command } 参数对象
		const transport = new StdioClientTransport({ command: 'node' });
		assert.ok(transport, 'StdioClientTransport 实例化必须成功');
		assert.strictEqual(typeof transport.start, 'function', 'Transport 必须暴露 start 方法');
		assert.strictEqual(typeof transport.close, 'function', 'Transport 必须暴露 close 方法');
	});

	it('Streamable HTTP Transport 可用 URL 实例化', () => {
		// 验证 StreamableHTTPClientTransport 构造签名：接受 URL 参数
		const transport = new StreamableHTTPClientTransport(new URL('https://127.0.0.1/mcp'));
		assert.ok(transport, 'StreamableHTTPClientTransport 实例化必须成功');
		assert.strictEqual(typeof transport.start, 'function');
		assert.strictEqual(typeof transport.terminateSession, 'function', 'Streamable HTTP Transport 必须暴露 terminateSession 方法');
	});

	it('SSE Transport 可用 URL 实例化', () => {
		// 验证 SSEClientTransport 构造签名：接受 URL 参数
		const transport = new SSEClientTransport(new URL('https://127.0.0.1/sse'));
		assert.ok(transport, 'SSEClientTransport 实例化必须成功');
		assert.strictEqual(typeof transport.start, 'function');
	});
});
