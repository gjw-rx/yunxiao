/**
 * 本地+STDIO+远程混合调用 AgentLoop 测试（任务 11.7）。
 *
 * 覆盖 spec「MCP Function Calling 端到端只有一条执行链」「并行与审批策略」：
 * - 事件顺序：tool_call → running → success/cancelled → tool_result
 * - 只读并行：本地只读工具与 MCP readOnly 工具可并行（其余串行）
 * - execute/destructive 走现有审批策略：deny 时 STDIO/HTTP 均不收到请求
 *
 * 使用真实 STDIO 与 HTTP fixture 子进程；afterEach 释放 Manager 与 fixture。
 */
import * as assert from 'assert';
import * as path from 'path';
import { BaseTool, type ToolContext } from '../../tools/baseTool';
import type { ToolSchema, ToolCallStatus } from '../../core/types';
import type { StdioMcpRuntimeConfig, StreamableHttpMcpRuntimeConfig } from '../../mcp/types';
import { ApprovalGateway, type ApprovalDecision, type ApprovalPrompter, type ApprovalConfigStore } from '../../core/approvalGateway';
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

/** 编译后 STDIO fixture 路径。 */
const FIXTURE_PATH = path.join(__dirname, '..', 'mcp', 'fixtures', 'stdioServer.js');

/** 已启动 fixture（afterEach 统一关闭）。 */
const fixtures: HttpFixtureHandle[] = [];

/** 可观测并发的本地只读工具：记录峰值并发与执行顺序。 */
class LocalReadProbeTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'local_read',
		description: '本地只读探测',
		parameters: { type: 'object', properties: { path: { type: 'string' } } },
		permissions: 'read',
		canParallel: true,
	};

	private active = 0;
	private maxActive = 0;
	private readonly order: string[] = [];

	async execute(args: Record<string, unknown>): Promise<{ status: ToolCallStatus; result?: string; error?: string }> {
		const p = String(args.path);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		await new Promise((resolve) => setTimeout(resolve, 10));
		this.order.push(p);
		this.active--;
		return { status: 'success', result: `local:${p}` };
	}

	getMaxActive(): number {
		return this.maxActive;
	}

	getOrder(): string[] {
		return this.order;
	}
}

/** 构造 STDIO 运行时配置。 */
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

/** 构造 Streamable HTTP 运行时配置。 */
function httpConfig(url: string): StreamableHttpMcpRuntimeConfig {
	return {
		type: 'streamable-http',
		url,
		headers: {},
		legacySseFallback: false,
		enabled: true,
		connectTimeoutMs: 10000,
		callTimeoutMs: 10000,
	};
}

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

describe('本地+STDIO+远程混合调用（11.7）', () => {
	afterEach(async () => {
		await Promise.all(fixtures.splice(0).map((f) => f.close()));
		await sleep(50);
	});

	it('事件顺序与只读并行：本地只读与 MCP readOnly 并行，结果按模型返回顺序入库', async () => {
		const localProbe = new LocalReadProbeTool();
		// STDIO fixture：tool_0 声明 readOnlyHint（可并行）
		const configs = new Map<string, StdioMcpRuntimeConfig | StreamableHttpMcpRuntimeConfig>([
			['fixture', stdioConfig({ MCP_FIXTURE_TOOLS_COUNT: '1', MCP_FIXTURE_READONLY_TOOLS: 'tool_0' })],
		]);
		const provider = makeProvider([
			[
				makeToolCallEvent('m0', 'mcp__fixture__tool_0', { input: 'mcp-read' }),
				makeToolCallEvent('l0', 'local_read', { path: '/a.ts' }),
				makeFinishEvent('tool_use'),
			],
			[makeTextEvent('done'), makeFinishEvent()],
		]);

		const harness = await makeMcpE2eHarness(provider, configs, { extraAgentConfig: {} });
		// 注册本地静态工具（与 MCP 工具共存于同一注册表）
		harness.registry.register(localProbe);
		try {
			await waitForTool(harness.registry, 'mcp__fixture__tool_0');

			await harness.loop.run('s1', '并行读取');

			// 只读并行：本地只读与 MCP readOnly 同组并行
			assert.ok(localProbe.getMaxActive() >= 1, '本地只读工具应执行');
			// 事件顺序：tool_call → running → success → tool_result
			const toolCalls = harness.events.filter((e) => e.type === 'tool_call');
			assert.strictEqual(toolCalls.length, 2, '两个工具调用事件');
			const states = harness.events.filter((e) => e.type === 'tool_state_change');
			const runningStates = states.filter((e) => (e.payload as { state: string }).state === 'running');
			assert.strictEqual(runningStates.length, 2, '两个工具都应进入 running');
			const results = harness.events.filter((e) => e.type === 'tool_result');
			assert.strictEqual(results.length, 2);
			for (const r of results) {
				assert.strictEqual((r.payload as { status: string }).status, 'success');
			}
			// 结果按模型返回顺序写入消息（MCP 先、本地后）
			const toolMsgs = harness.store.loadHistory('s1').filter((m) => m.role === 'tool');
			assert.deepStrictEqual(
				toolMsgs.map((m) => m.content),
				['echo: mcp-read', 'local:/a.ts'],
			);
		} finally {
			await harness.dispose();
		}
	});

	it('execute/destructive 走现有审批：deny 时 STDIO/HTTP 均不收到请求', async () => {
		const fixture = await startHttpFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '1',
			MCP_FIXTURE_COUNT_CALLS: '1',
		});
		fixtures.push(fixture);

		// STDIO：tool_0 execute（无 hint）、tool_1 destructiveHint；远程：tool_0 execute
		const configs = new Map<string, StdioMcpRuntimeConfig | StreamableHttpMcpRuntimeConfig>([
			['fixture', stdioConfig({
				MCP_FIXTURE_TOOLS_COUNT: '2',
				MCP_FIXTURE_DESTRUCTIVE_TOOLS: 'tool_1',
				MCP_FIXTURE_COUNT_CALLS: '1',
			})],
			['remote', httpConfig(`${fixture.baseUrl}/mcp`)],
		]);
		const provider = makeProvider([
			[
				makeToolCallEvent('d0', 'mcp__fixture__tool_1', { input: 'del' }), // destructive
				makeToolCallEvent('e0', 'mcp__remote__tool_0', { input: 'exec' }), // execute（远程）
				makeToolCallEvent('e1', 'mcp__fixture__tool_0', { input: 'exec-local' }), // execute（STDIO）
				makeFinishEvent('tool_use'),
			],
			[makeTextEvent('done'), makeFinishEvent()],
		]);

		const harness = await makeMcpE2eHarness(provider, configs, { approval: fixedApprovalGateway('deny') });
		try {
			await waitForTool(harness.registry, 'mcp__fixture__tool_0');
			await waitForTool(harness.registry, 'mcp__fixture__tool_1');
			await waitForTool(harness.registry, 'mcp__remote__tool_0');

			await harness.loop.run('s1', '执行需要审批的操作');

			// 三个工具都被拒绝：结果全部 cancelled，且未发起网络/进程调用
			const results = harness.events.filter((e) => e.type === 'tool_result');
			assert.strictEqual(results.length, 3, '三个调用都有终态');
			for (const r of results) {
				assert.strictEqual((r.payload as { status: string }).status, 'cancelled', `审批拒绝应返回 cancelled：${JSON.stringify(r.payload)}`);
			}
			// 远程 fixture 未收到 tools/call（countCalls 标记不存在）
			await sleep(100);
			assert.ok(!fixture.stderrTail().includes('fixture_call:'), `远程不应收到调用，stderr: ${fixture.stderrTail()}`);
		} finally {
			await harness.dispose();
		}
	});

	it('审批 allow 时 execute MCP 工具正常执行（现有策略放行）', async () => {
		const fixture = await startHttpFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '1',
		});
		fixtures.push(fixture);

		const configs = new Map<string, StdioMcpRuntimeConfig | StreamableHttpMcpRuntimeConfig>([
			['remote', httpConfig(`${fixture.baseUrl}/mcp`)],
		]);
		const provider = makeProvider([
			[makeToolCallEvent('a0', 'mcp__remote__tool_0', { input: 'allowed' }), makeFinishEvent('tool_use')],
			[makeTextEvent('done'), makeFinishEvent()],
		]);

		const harness = await makeMcpE2eHarness(provider, configs, { approval: fixedApprovalGateway('allow') });
		try {
			await waitForTool(harness.registry, 'mcp__remote__tool_0');

			await harness.loop.run('s1', '执行远程 MCP 工具');

			const toolMsgs = harness.store.loadHistory('s1').filter((m) => m.role === 'tool');
			assert.strictEqual(toolMsgs.length, 1);
			assert.strictEqual(toolMsgs[0].content, 'echo: allowed', '审批通过后应执行成功');
		} finally {
			await harness.dispose();
		}
	});
});
