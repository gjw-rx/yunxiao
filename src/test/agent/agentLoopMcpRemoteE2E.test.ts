/**
 * Streamable HTTP AgentLoop 端到端测试（任务 11.6）。
 *
 * 覆盖 spec「MCP Function Calling 端到端只有一条执行链」远程侧：
 * - endpoint/headers 不来自模型参数：模型只能传 inputSchema 允许的 input 字段，
 *   无法指定 URL 或 header（header 由配置注入并到达 fixture）
 * - call ID 全链一致：模型 call ID → ToolResult.call_id → MessageStore toolCallId
 *
 * 使用真实 HTTP fixture 子进程（out/test/mcp/fixtures/httpServer.js），
 * afterEach 释放 Manager 与 fixture。
 */
import * as assert from 'assert';
import type { StreamableHttpMcpRuntimeConfig } from '../../mcp/types';
import { startHttpFixture, type HttpFixtureHandle } from '../mcp/fixtures/httpFixtureHelper';
import {
	makeMcpE2eHarness,
	makeProvider,
	makeToolCallEvent,
	makeTextEvent,
	makeFinishEvent,
	waitForTool,
	sleep,
} from './mcpE2eHelpers';

/** 已启动 fixture（afterEach 统一关闭）。 */
const fixtures: HttpFixtureHandle[] = [];

/** 构造 Streamable HTTP 运行时配置。 */
function httpConfig(url: string, headers: Record<string, string>): StreamableHttpMcpRuntimeConfig {
	return {
		type: 'streamable-http',
		url,
		headers,
		legacySseFallback: false,
		enabled: true,
		connectTimeoutMs: 10000,
		callTimeoutMs: 10000,
	};
}

describe('Streamable HTTP AgentLoop 端到端（11.6）', () => {
	afterEach(async () => {
		await Promise.all(fixtures.splice(0).map((f) => f.close()));
		await sleep(50);
	});

	it('endpoint/headers 不来自模型参数，call ID 全链一致', async () => {
		const fixture = await startHttpFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '1',
			MCP_HTTP_INSPECT_HEADERS: '1',
		});
		fixtures.push(fixture);

		// 模型只提供 input 参数——没有任何字段可携带 endpoint/headers
		const provider = makeProvider([
			[makeToolCallEvent('call-remote-1', 'mcp__remote__tool_0', { input: 'remote-hello' }), makeFinishEvent('tool_use')],
			[makeTextEvent('done'), makeFinishEvent()],
		]);

		const harness = await makeMcpE2eHarness(
			provider,
			new Map([['remote', httpConfig(`${fixture.baseUrl}/mcp`, { Authorization: 'Bearer test-token-456' })]]),
		);
		try {
			await waitForTool(harness.registry, 'mcp__remote__tool_0');

			await harness.loop.run('s1', '调用远程 MCP 工具');

			// 1. 结果到达 MessageStore，call ID 全链一致
			const history = harness.store.loadHistory('s1');
			const toolMsg = history.find((m) => m.role === 'tool');
			assert.ok(toolMsg, '应写入 tool 消息');
			assert.strictEqual(toolMsg!.content, 'echo: remote-hello', '远程 fixture 应回显输入');
			assert.strictEqual(toolMsg!.toolCallId, 'call-remote-1', 'call ID 应全链一致');

			// 2. header 由配置注入并到达 Server（非模型参数）
			const tail = fixture.stderrTail();
			assert.ok(tail.includes('Bearer test-token-456'), `Authorization header 应到达 Server，stderr: ${tail}`);

			// 3. 下一轮模型被调用
			assert.strictEqual(harness.provider.callCount(), 2);
		} finally {
			await harness.dispose();
		}
	});

	it('endpoint/headers 不来自模型参数：越界字段不成为 HTTP header，请求仍发往配置 endpoint', async () => {
		const fixture = await startHttpFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '1',
			MCP_HTTP_INSPECT_HEADERS: '1',
		});
		fixtures.push(fixture);

		// 模型在参数中夹带 url/headers（试图注入 endpoint/凭据）——
		// 这些字段只是普通 JSON 参数，绝不成为 HTTP header 或改变请求目标
		const provider = makeProvider([
			[
				makeToolCallEvent('call-2', 'mcp__remote__tool_0', {
					input: 'x',
					url: 'http://evil.example.com/mcp',
					headers: { Authorization: 'Bearer leaked' },
				}),
				makeFinishEvent('tool_use'),
			],
			[makeTextEvent('done'), makeFinishEvent()],
		]);

		const harness = await makeMcpE2eHarness(
			provider,
			new Map([['remote', httpConfig(`${fixture.baseUrl}/mcp`, { Authorization: 'Bearer config-token' })]]),
		);
		try {
			await waitForTool(harness.registry, 'mcp__remote__tool_0');

			await harness.loop.run('s1', '调用远程 MCP 工具');

			// 1. 请求仍发往配置 endpoint 并成功回显；call ID 全链一致
			const history = harness.store.loadHistory('s1');
			const toolMsg = history.find((m) => m.role === 'tool');
			assert.ok(toolMsg, '应写入 tool 消息');
			assert.strictEqual(toolMsg!.content, 'echo: x', '请求应到达配置的 endpoint 并回显');
			assert.strictEqual(toolMsg!.toolCallId, 'call-2', 'call ID 应全链一致');

			// 2. 只有配置注入的 header 到达 Server；模型夹带的 leaked 值不成为 HTTP header
			await sleep(50);
			const tail = fixture.stderrTail();
			assert.ok(tail.includes('Bearer config-token'), `配置 header 应到达 Server，stderr: ${tail}`);
			assert.ok(!tail.includes('Bearer leaked'), `模型夹带的 header 不应到达 Server，stderr: ${tail}`);
		} finally {
			await harness.dispose();
		}
	});
});
