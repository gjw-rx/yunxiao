/**
 * STDIO AgentLoop 端到端测试（任务 11.5）。
 *
 * 覆盖 spec「MCP Function Calling 端到端只有一条执行链」：
 * Function Call → ToolRouter → McpToolAdapter → Manager.callTool → STDIO fixture →
 * governed result → MessageStore → 下一轮模型。
 *
 * 使用真实 STDIO fixture 子进程（out/test/mcp/fixtures/stdioServer.js），
 * afterEach 释放 Manager 与 fixture，避免悬挂子进程。
 */
import * as assert from 'assert';
import * as path from 'path';
import type { StdioMcpRuntimeConfig } from '../../mcp/types';
import {
	makeMcpE2eHarness,
	makeProvider,
	makeToolCallEvent,
	makeTextEvent,
	makeFinishEvent,
	waitForTool,
	sleep,
} from './mcpE2eHelpers';

/** 编译后 STDIO fixture 路径（测试在 out/test/agent/ 下，fixture 在 out/test/mcp/fixtures/ 下）。 */
const FIXTURE_PATH = path.join(__dirname, '..', 'mcp', 'fixtures', 'stdioServer.js');

/** 构造 STDIO 运行时配置（CodeGraph-like：node 启动 fixture 子进程）。 */
function stdioConfig(env: Record<string, string> = {}): StdioMcpRuntimeConfig {
	return {
		type: 'stdio',
		command: 'node',
		args: [FIXTURE_PATH],
		env,
		enabled: true,
		connectTimeoutMs: 10000,
		callTimeoutMs: 10000,
	};
}

describe('STDIO AgentLoop 端到端（11.5）', () => {
	it('Function Call → ToolRouter → fixture → governed result → MessageStore → 下一轮模型', async () => {
		// 第一轮：模型发起 MCP tool call；第二轮：收到结果后给出最终文本
		const provider = makeProvider([
			[makeToolCallEvent('call-1', 'mcp__fixture__tool_0', { input: 'hello-e2e' }), makeFinishEvent('tool_use')],
			[makeTextEvent('done'), makeFinishEvent()],
		]);

		const harness = await makeMcpE2eHarness(provider, new Map([['fixture', stdioConfig({ MCP_FIXTURE_TOOLS_COUNT: '3' })]]));
		try {
			// 前置：MCP 工具已注册到 ToolRegistry（namespaced exposed name）
			await waitForTool(harness.registry, 'mcp__fixture__tool_0');
			assert.ok(harness.registry.list().some((s) => s.name === 'mcp__fixture__tool_1'), '应发现多个工具');

			await harness.loop.run('s1', '请调用 MCP 工具');

			// ── 链尾断言 ──
			// 1. governed result 进入 MessageStore（fixture 回显 echo: hello-e2e）
			const history = harness.store.loadHistory('s1');
			const toolMsg = history.find((m) => m.role === 'tool');
			assert.ok(toolMsg, '应写入 tool 消息');
			assert.strictEqual(toolMsg!.content, 'echo: hello-e2e', '结果应经治理后保留回显文本');
			assert.strictEqual(toolMsg!.toolCallId, 'call-1', 'tool 消息应携带模型 call ID');

			// 2. 下一轮模型被调用（第一轮 tool call + 第二轮最终文本）
			assert.strictEqual(harness.provider.callCount(), 2, '模型应被调用两轮');

			// 3. 事件顺序：tool_call → running → success → tool_result
			const toolCalls = harness.events.filter((e) => e.type === 'tool_call');
			assert.strictEqual(toolCalls.length, 1);
			const stateChanges = harness.events.filter((e) => e.type === 'tool_state_change');
			assert.ok(stateChanges.length >= 1, '应发出工具状态事件');
			assert.strictEqual((stateChanges[0].payload as { state: string }).state, 'running');
			const results = harness.events.filter((e) => e.type === 'tool_result');
			assert.strictEqual(results.length, 1);
			assert.strictEqual((results[0].payload as { status: string }).status, 'success');
		} finally {
			await harness.dispose();
		}
	});

	it('MCP instructions 快照进入系统提示词（AgentLoop 每轮读取）', async () => {
		const provider = makeProvider([
			[makeTextEvent('done'), makeFinishEvent()],
		]);

		const harness = await makeMcpE2eHarness(
			provider,
			new Map([['fixture', stdioConfig({ MCP_FIXTURE_TOOLS_COUNT: '1', MCP_FIXTURE_INSTRUCTIONS: '请使用工具 tool_0 查询' })]],
			),
			{ mcpInstructions: true },
		);
		try {
			await waitForTool(harness.registry, 'mcp__fixture__tool_0');
			// 等待 instructions 快照发布
			await sleep(200);
			const instructions = harness.manager.getInstructions();
			assert.ok(instructions.length > 0, 'ready Server 应发布 instructions 快照');
			assert.strictEqual(instructions[0].content, '请使用工具 tool_0 查询');
		} finally {
			await harness.dispose();
		}
	});
});
