/**
 * 可编程测试 fixture HTTP MCP Server（任务 8.1）。
 *
 * 职责：作为 StreamableHTTPClientTransport / SSEClientTransport 的远程目标，通过
 * 环境变量控制行为——
 * - mode=streamable：Streamable HTTP stateful（每 initialize 创建独立 session transport）
 * - mode=streamable-stateless：Streamable HTTP stateless（单一 transport，无 session）
 * - mode=sse：legacy SSE-only（GET /sse + POST /messages，模拟旧 HTTP+SSE Server）
 * - mode=compat-fail：/mcp 返回 404 表示不支持 Streamable HTTP，同时提供 /sse + /messages
 *   供 legacy SSE 回退连接成功
 * - 401/403/5xx：在 /mcp 直接返回指定状态码（负向回退测试，证明不触发 SSE 回退）
 * - delayMs：处理前延迟（连接超时 / 调用超时测试）
 * - redirectOrigin：/mcp 302 跳转到不同 origin（跨 origin 重定向拒绝测试）
 * - inspectHeaders：把 Authorization 头写入 stderr（同 origin header 注入断言）
 * - toolsCount/pageSize/instructions/listChanged/callDelayMs/toolError/failOnSecondPage/countCalls
 *
 * 启动后在 stdout 输出 `HTTP_FIXTURE_PORT=<port>`，宿主读取以获取实际端口。
 */
import * as http from 'node:http';
import * as process from 'node:process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';

/** Fixture 环境变量配置。 */
interface FixtureConfig {
	readonly mode: 'streamable' | 'streamable-stateless' | 'sse' | 'compat-fail';
	readonly port: number;
	readonly toolsCount: number;
	readonly pageSize: number;
	readonly instructions: string;
	readonly callDelayMs: number;
	readonly statusCode: number;
	readonly delayMs: number;
	readonly redirectOrigin: string;
	readonly inspectHeaders: boolean;
	readonly toolErrorName: string;
	readonly listChanged: boolean;
	readonly listChangedDelayMs: number;
	readonly listChangedToolsCount: number;
	readonly failOnSecondPage: boolean;
	readonly countCalls: boolean;
	/** 带 readOnlyHint 的工具名列表（逗号分隔，如 tool_0,tool_1；用于权限映射/并行测试）。 */
	readonly readOnlyTools: string[];
	/** 带 destructiveHint 的工具名列表（逗号分隔；用于权限映射测试）。 */
	readonly destructiveTools: string[];
}

/** 从环境变量读取配置。 */
function readConfig(): FixtureConfig {
	const env = process.env;
	return {
		mode: (env.MCP_HTTP_MODE ?? 'streamable') as FixtureConfig['mode'],
		port: parseInt(env.MCP_HTTP_PORT ?? '0', 10),
		toolsCount: parseInt(env.MCP_FIXTURE_TOOLS_COUNT ?? '3', 10),
		pageSize: parseInt(env.MCP_FIXTURE_PAGE_SIZE ?? '0', 10),
		instructions: env.MCP_FIXTURE_INSTRUCTIONS ?? '',
		callDelayMs: parseInt(env.MCP_FIXTURE_CALL_DELAY_MS ?? '0', 10),
		statusCode: parseInt(env.MCP_HTTP_STATUS ?? '0', 10),
		delayMs: parseInt(env.MCP_HTTP_DELAY_MS ?? '0', 10),
		redirectOrigin: env.MCP_HTTP_REDIRECT_ORIGIN ?? '',
		inspectHeaders: env.MCP_HTTP_INSPECT_HEADERS === '1',
		toolErrorName: env.MCP_FIXTURE_TOOL_ERROR ?? '',
		listChanged: env.MCP_FIXTURE_LIST_CHANGED === '1',
		listChangedDelayMs: parseInt(env.MCP_FIXTURE_LIST_CHANGED_DELAY_MS ?? '100', 10),
		listChangedToolsCount: parseInt(env.MCP_FIXTURE_LIST_CHANGED_TOOLS_COUNT ?? '-1', 10),
		failOnSecondPage: env.MCP_FIXTURE_FAIL_ON_SECOND_PAGE === '1',
		countCalls: env.MCP_FIXTURE_COUNT_CALLS === '1',
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

/** 等待毫秒。 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取请求体为字符串。 */
function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/** 创建配置好的 MCP Server（共享 tools/list 与 tools/call 行为）。 */
function createMcpServer(config: FixtureConfig): { server: Server; toolsRef: { tools: ReturnType<typeof buildTools> } } {
	const toolsRef = { tools: buildTools(config.toolsCount, config.readOnlyTools, config.destructiveTools) };
	const server = new Server(
		{ name: 'http-fixture', version: '1.0.0' },
		{
			capabilities: { tools: { listChanged: true } },
			...(config.instructions ? { instructions: config.instructions } : {}),
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async (request) => {
		const cursor = request.params?.cursor;
		const startIndex = cursor ? parseInt(cursor, 10) : 0;
		if (cursor && config.failOnSecondPage) {
			throw new Error('fixture: 第二页发现失败（failOnSecondPage）');
		}
		if (config.pageSize > 0 && startIndex + config.pageSize < toolsRef.tools.length) {
			return { tools: toolsRef.tools.slice(startIndex, startIndex + config.pageSize), nextCursor: String(startIndex + config.pageSize) };
		}
		return { tools: toolsRef.tools.slice(startIndex) };
	});

	let callCount = 0;
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		callCount += 1;
		if (config.countCalls) {
			process.stderr.write(`fixture_call:${callCount}\n`);
		}
		if (config.callDelayMs > 0) {
			await sleep(config.callDelayMs);
		}
		const { name, arguments: args } = request.params;
		if (name === config.toolErrorName) {
			return { content: [{ type: 'text' as const, text: `工具 ${name} 返回业务错误` }], isError: true };
		}
		const input = typeof args?.input === 'string' ? args.input : '';
		return { content: [{ type: 'text' as const, text: `echo: ${input}` }] };
	});

	return { server, toolsRef };
}

/** 主入口：启动 HTTP fixture。 */
async function main(): Promise<void> {
	const config = readConfig();

	// stateful Streamable HTTP：按 session 维护 transport+server
	const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server; toolsRef: { tools: ReturnType<typeof buildTools> } }>();
	// legacy SSE：按 session 维护 transport+server
	const sseSessions = new Map<string, { transport: SSEServerTransport; server: Server }>();

	/** 终止 stateful session。 */
	async function terminateSession(sessionId: string): Promise<void> {
		const entry = sessions.get(sessionId);
		if (!entry) {
			return;
		}
		sessions.delete(sessionId);
		await entry.server.close();
		await entry.transport.close();
	}

	const httpServer = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', 'http://localhost');

			// 处理前延迟（连接/调用超时测试）
			if (config.delayMs > 0) {
				await sleep(config.delayMs);
			}

			// 头部检查：把 Authorization 写入 stderr（同 origin header 注入断言）
			if (config.inspectHeaders && req.headers.authorization) {
				process.stderr.write(JSON.stringify({ authorization: req.headers.authorization }) + '\n');
			}

			// 跨 origin 重定向：/mcp 302 到不同 origin
			if (config.redirectOrigin && url.pathname === '/mcp') {
				res.writeHead(302, { Location: `${config.redirectOrigin}${url.pathname}` });
				res.end();
				return;
			}

			// 状态码错误：/mcp 直接返回 401/403/5xx（负向回退测试）
			if (config.statusCode > 0 && url.pathname === '/mcp') {
				res.writeHead(config.statusCode);
				res.end();
				return;
			}

			// ── Streamable HTTP 分支 ──
			if (config.mode === 'streamable' || config.mode === 'streamable-stateless') {
				if (url.pathname !== '/mcp') {
					res.writeHead(404);
					res.end();
					return;
				}
				// stateless：每个请求创建全新 transport+server（SDK 要求 stateless transport 不可复用）
				if (config.mode === 'streamable-stateless') {
					const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
					const { server } = createMcpServer(config);
					await server.connect(transport);
					const body = req.method === 'POST' ? await readBody(req) : undefined;
					await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
					return;
				}
				// stateful：按 Mcp-Session-Id 路由；initialize（无 session）创建新 session
				const sessionId = req.headers['mcp-session-id'] as string | undefined;
				if (req.method === 'DELETE') {
					if (sessionId) {
						process.stderr.write(`fixture_terminate:${sessionId}\n`);
						await terminateSession(sessionId);
					}
					res.writeHead(200);
					res.end();
					return;
				}
				if (req.method === 'POST' && !sessionId) {
					// 新 session：initialize
					const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
					const { server, toolsRef } = createMcpServer(config);
					await server.connect(transport);
					const body = await readBody(req);
					await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
					const newId = transport.sessionId;
					if (newId) {
						sessions.set(newId, { transport, server, toolsRef });
						// 可选：延迟发送 list_changed
						if (config.listChanged) {
							setTimeout(() => {
							if (config.listChangedToolsCount >= 0) {
								toolsRef.tools = buildTools(config.listChangedToolsCount, config.readOnlyTools, config.destructiveTools);
							}
							server.notification({ method: 'notifications/tools/list_changed' }).catch(() => undefined);
						}, config.listChangedDelayMs);
						}
					}
					return;
				}
				// 既有 session
				const entry = sessionId ? sessions.get(sessionId) : undefined;
				if (!entry) {
					res.writeHead(404);
					res.end();
					return;
				}
				const body = req.method === 'POST' ? await readBody(req) : undefined;
				await entry.transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
				return;
			}

			// ── Legacy SSE / compat-fail 分支 ──
			// compat-fail：/mcp 返回 404 表示不支持 Streamable HTTP
			if (config.mode === 'compat-fail' && url.pathname === '/mcp') {
				res.writeHead(404);
				res.end();
				return;
			}
			// GET /sse：建立 SSE 流，创建 SSEServerTransport
			if (url.pathname === '/sse' && req.method === 'GET') {
				const transport = new SSEServerTransport('/messages', res);
				const { server } = createMcpServer(config);
				await server.connect(transport);
				sseSessions.set(transport.sessionId, { transport, server });
				if (config.listChanged) {
					setTimeout(() => server.notification({ method: 'notifications/tools/list_changed' }).catch(() => undefined), config.listChangedDelayMs);
				}
				return;
			}
			// POST /messages：路由到对应 SSE session
			if (url.pathname === '/messages' && req.method === 'POST') {
				const sid = url.searchParams.get('sessionId') ?? '';
				const entry = sseSessions.get(sid);
				if (!entry) {
					res.writeHead(404);
					res.end();
					return;
				}
				const body = await readBody(req);
				await entry.transport.handlePostMessage(req, res, body ? JSON.parse(body) : undefined);
				return;
			}

			res.writeHead(404);
			res.end();
		} catch (err) {
			process.stderr.write(`Fixture handler error: ${err instanceof Error ? err.message : String(err)}\n`);
			try {
				if (!res.headersSent) {
					res.writeHead(500);
					res.end();
				}
			} catch {
				// 忽略
			}
		}
	});

	httpServer.listen(config.port, '127.0.0.1', () => {
		const addr = httpServer.address();
		const port = typeof addr === 'object' && addr ? addr.port : config.port;
		process.stdout.write(`HTTP_FIXTURE_PORT=${port}\n`);
	});
}

main().catch((err) => {
	process.stderr.write(`Fixture server error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
