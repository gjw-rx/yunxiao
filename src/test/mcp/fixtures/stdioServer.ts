/**
 * 可编程测试 fixture STDIO MCP Server（任务 7.1）。
 *
 * 职责：作为 StdioClientTransport 的子进程目标，通过环境变量控制行为——
 * - initialize/协议协商（SDK Server 自动处理）
 * - instructions（通过 ServerOptions.instructions 返回）
 * - 分页 tools/list（按 PAGE_SIZE 分页，跟随 cursor）
 * - list_changed 通知（可选，延迟发送）
 * - tools/call（支持 isError、延迟、echo 参数）
 * - stderr 输出（有界诊断，不影响 stdout 协议）
 * - 异常退出（立即 exit 指定退出码）
 *
 * 启动：node out/test/mcp/fixtures/stdioServer.js
 * 配置：通过环境变量控制行为（详见 FixtureConfig 注释）。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as process from 'node:process';

/** Fixture 环境变量配置。 */
interface FixtureConfig {
	/** 暴露的工具数量（默认 3）。 */
	readonly toolsCount: number;
	/** tools/list 每页大小（默认 0=不分页）。 */
	readonly pageSize: number;
	/** Server instructions 文本（默认空）。 */
	readonly instructions: string;
	/** tools/call 响应延迟（毫秒，默认 0）。 */
	readonly callDelayMs: number;
	/** 启动时写入 stderr 的文本（默认空）。 */
	readonly stderrText: string;
	/** 立即以指定退出码退出（-1=不退出，默认 -1）。 */
	readonly exitCode: number;
	/** 返回 isError 的工具名（默认无）。 */
	readonly toolErrorName: string;
	/** 初始发现后是否发送 list_changed 通知（默认 false）。 */
	readonly listChanged: boolean;
	/** list_changed 延迟（毫秒，默认 100）。 */
	readonly listChangedDelayMs: number;
	/** 启动时向 stderr 写入 cwd 与 FIXTURE_MARKER（用于 cwd/env 装配断言）。 */
	readonly inspectStderr: boolean;
	/** 保持进程存活但不响应 initialize（用于连接超时测试）。 */
	readonly hangInit: boolean;
	/** 手动返回不兼容 protocolVersion 的 initialize 响应（用于协议不兼容测试）。 */
	readonly badProtocol: boolean;
	/** 发送 list_changed 前把工具数量重建为该值（用于工具列表变化测试）。 */
	readonly listChangedToolsCount: number;
	/** tools/list 携带 cursor（第二页及以后）时抛错（用于刷新失败测试）。 */
	readonly failOnSecondPage: boolean;
	/** 每个 tools/call 向 stderr 写入一次计数标记（用于 exactly-once 验证）。 */
	readonly countCalls: boolean;
	/** 就绪后延迟指定毫秒以退出码 0 正常退出（用于正常退出/连接断开测试，默认 -1=不退出）。 */
	readonly exitAfterMs: number;
	/** 带 readOnlyHint 的工具名列表（逗号分隔，如 tool_0,tool_1；用于权限映射/并行测试）。 */
	readonly readOnlyTools: string[];
	/** 带 destructiveHint 的工具名列表（逗号分隔；用于权限映射测试）。 */
	readonly destructiveTools: string[];
}

/** 从环境变量读取配置。 */
function readConfig(): FixtureConfig {
	const env = process.env;
	return {
		toolsCount: parseInt(env.MCP_FIXTURE_TOOLS_COUNT ?? '3', 10),
		pageSize: parseInt(env.MCP_FIXTURE_PAGE_SIZE ?? '0', 10),
		instructions: env.MCP_FIXTURE_INSTRUCTIONS ?? '',
		callDelayMs: parseInt(env.MCP_FIXTURE_CALL_DELAY_MS ?? '0', 10),
		stderrText: env.MCP_FIXTURE_STDERR_TEXT ?? '',
		exitCode: parseInt(env.MCP_FIXTURE_EXIT_CODE ?? '-1', 10),
		toolErrorName: env.MCP_FIXTURE_TOOL_ERROR ?? '',
		listChanged: env.MCP_FIXTURE_LIST_CHANGED === '1',
		listChangedDelayMs: parseInt(env.MCP_FIXTURE_LIST_CHANGED_DELAY_MS ?? '100', 10),
		inspectStderr: env.MCP_FIXTURE_INSPECT_STDERR === '1',
		hangInit: env.MCP_FIXTURE_HANG_INIT === '1',
		badProtocol: env.MCP_FIXTURE_BAD_PROTOCOL === '1',
		listChangedToolsCount: parseInt(env.MCP_FIXTURE_LIST_CHANGED_TOOLS_COUNT ?? '-1', 10),
		failOnSecondPage: env.MCP_FIXTURE_FAIL_ON_SECOND_PAGE === '1',
		countCalls: env.MCP_FIXTURE_COUNT_CALLS === '1',
		exitAfterMs: parseInt(env.MCP_FIXTURE_EXIT_AFTER_MS ?? '-1', 10),
		readOnlyTools: (env.MCP_FIXTURE_READONLY_TOOLS ?? '').split(',').filter(Boolean),
		destructiveTools: (env.MCP_FIXTURE_DESTRUCTIVE_TOOLS ?? '').split(',').filter(Boolean),
	};
}

/** 生成工具列表（按配置附加 annotations）。 */
function buildTools(
	count: number,
	readOnlyTools: string[],
	destructiveTools: string[],
): Array<{ name: string; description: string; inputSchema: Record<string, unknown>; annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean } }> {
	return Array.from({ length: count }, (_, i) => {
		const name = `tool_${i}`;
		const annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {};
		if (readOnlyTools.includes(name)) {
			annotations.readOnlyHint = true;
		}
		if (destructiveTools.includes(name)) {
			annotations.destructiveHint = true;
		}
		return {
			name,
			description: `测试工具 ${i}`,
			inputSchema: {
				type: 'object',
				properties: { input: { type: 'string', description: '输入文本' } },
				required: [],
			},
			...(Object.keys(annotations).length > 0 ? { annotations } : {}),
		};
	});
}

/** 主入口：启动 fixture STDIO MCP Server。 */
async function main(): Promise<void> {
	const config = readConfig();

	// 立即退出（异常退出测试）
	if (config.exitCode >= 0) {
		process.exit(config.exitCode);
	}

	// 写入 stderr 诊断
	if (config.stderrText) {
		process.stderr.write(config.stderrText);
	}

	// 向 stderr 写入 cwd 与 FIXTURE_MARKER（cwd/env 装配断言用），随后继续正常启动
	if (config.inspectStderr) {
		process.stderr.write(JSON.stringify({ cwd: process.cwd(), marker: process.env.FIXTURE_MARKER ?? '' }) + '\n');
	}

	// 保持存活但不响应 initialize（连接超时测试用）
	if (config.hangInit) {
		process.stderr.write('hanging init\n');
		setInterval(() => undefined, 1000);
		return;
	}

	// 手动返回不兼容 protocolVersion 的 initialize 响应（协议不兼容测试用）
	if (config.badProtocol) {
		process.stdin.on('data', (chunk: Buffer) => {
			for (const line of chunk.toString('utf8').split('\n')) {
				if (!line) { continue; }
				let msg: { method?: string; id?: unknown };
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (msg.method === 'initialize' && msg.id !== undefined) {
					const response = {
						jsonrpc: '2.0',
						id: msg.id,
						result: {
							protocolVersion: '999.0.0',
							capabilities: { tools: {} },
							serverInfo: { name: 'bad-protocol', version: '1.0.0' },
						},
					};
					process.stdout.write(`${JSON.stringify(response)}\n`);
				}
			}
		});
		setInterval(() => undefined, 1000);
		return;
	}

	let allTools = buildTools(config.toolsCount, config.readOnlyTools, config.destructiveTools);

	const server = new Server(
		{ name: 'stdio-fixture', version: '1.0.0' },
		{
			capabilities: {
				tools: { listChanged: true },
			},
			...(config.instructions ? { instructions: config.instructions } : {}),
		},
	);

	// tools/list 处理（支持分页；failOnSecondPage 在携带 cursor 时抛错以模拟刷新失败）
	server.setRequestHandler(ListToolsRequestSchema, async (request) => {
		const cursor = request.params?.cursor;
		const startIndex = cursor ? parseInt(cursor, 10) : 0;

		if (cursor && config.failOnSecondPage) {
			throw new Error('fixture: 第二页发现失败（failOnSecondPage）');
		}

		if (config.pageSize > 0 && startIndex + config.pageSize < allTools.length) {
			return {
				tools: allTools.slice(startIndex, startIndex + config.pageSize),
				nextCursor: String(startIndex + config.pageSize),
			};
		}
		return { tools: allTools.slice(startIndex) };
	});

	// tools/call 处理（支持 isError、延迟、echo、调用计数）
	let callCount = 0;
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		callCount += 1;
		if (config.countCalls) {
			// 在延迟前写入计数标记，便于宿主验证工具被实际调用次数（exactly-once）
			process.stderr.write(`fixture_call:${callCount}\n`);
		}
		if (config.callDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, config.callDelayMs));
		}

		const { name, arguments: args } = request.params;

		if (name === config.toolErrorName) {
			return {
				content: [{ type: 'text' as const, text: `工具 ${name} 返回业务错误` }],
				isError: true,
			};
		}

		const input = typeof args?.input === 'string' ? args.input : '';
		return {
			content: [{ type: 'text' as const, text: `echo: ${input}` }],
		};
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);

	// 可选：延迟发送 list_changed 通知（发送前可按 listChangedToolsCount 重建工具列表）
	if (config.listChanged) {
		setTimeout(() => {
			if (config.listChangedToolsCount >= 0) {
				allTools = buildTools(config.listChangedToolsCount, config.readOnlyTools, config.destructiveTools);
			}
			server.notification({ method: 'notifications/tools/list_changed' }).catch(() => {
				// 通知发送失败时静默退出（连接可能已关闭）
			});
		}, config.listChangedDelayMs);
	}

	// 可选：就绪后延迟正常退出（模拟 Server 自行退出，用于连接断开测试）
	if (config.exitAfterMs >= 0) {
		setTimeout(() => process.exit(0), config.exitAfterMs);
	}
}

main().catch((err) => {
	process.stderr.write(`Fixture server error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
