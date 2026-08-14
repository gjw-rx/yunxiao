/**
 * MCP Transport 工厂（任务 7.3 / 8.3 / 8.5 / 8.8）。
 *
 * 职责：按运行时配置创建官方 Transport，封装 Transport 特定细节（STDIO stderr
 * 有界消费、远程 header 注入与 legacy SSE 回退），向 Connection 暴露统一的
 * Handle。Connection 只依赖 Handle 接口，不直接引用具体 Transport 类型。
 *
 * 当前实现：STDIO（createStdioTransport）、Streamable HTTP（createStreamableHttpTransport）、
 * Legacy SSE（createLegacySseTransport）。
 *
 * 安全：STDIO command/args 直接交给官方 StdioClientTransport（内部 cross-spawn，
 * shell=false），不经 shell 拼接；env 来自 SecretStorage 装配的运行时配置；
 * stderr 通过 pipe 有界收集，正文不推给模型。远程 headers 只注入到同 origin 请求，
 * 跨 origin redirect 被拒绝以防 header 泄漏。Legacy SSE 同样注入静态 headers。
 */
import { StdioClientTransport, StreamableHTTPClientTransport, SSEClientTransport } from './sdk';
import type { Transport } from './sdk';
import type { McpActualTransport, McpServerRuntimeConfig, StdioMcpRuntimeConfig, StreamableHttpMcpRuntimeConfig } from './types';

/** stderr 有界尾部最大字节数。 */
const STDERR_TAIL_MAX_BYTES = 8192;
/** 远程 session 终止有界超时（毫秒）。 */
const TERMINATE_SESSION_TIMEOUT_MS = 3000;

/** 统一 Transport Handle：Connection 通过它操作底层 Transport 与清理资源。 */
export interface McpTransportHandle {
	/** 官方 Transport 实例（交给 Client.connect）。 */
	readonly transport: Transport;
	/** 实际建立连接的 Transport 类型（远程可能为 legacy-sse）。 */
	readonly actualTransport: McpActualTransport;
	/** STDIO stderr 有界尾部读取器（仅 STDIO 提供）。 */
	readonly stderrTail?: () => string;
	/** 关闭 Transport 及关联资源（STDIO 子进程 / 远程 session）。 */
	close(): Promise<void>;
}

/**
 * 创建 STDIO Transport Handle。
 *
 * @param config 运行时配置（env 已装配）；非 stdio 类型抛错
 * @param workspaceCwd 当前主工作区根，用于 config.cwd 缺省时展开
 * @returns STDIO Transport Handle
 */
export function createStdioTransport(config: McpServerRuntimeConfig, workspaceCwd?: string): McpTransportHandle {
	if (config.type !== 'stdio') {
		throw new Error(`createStdioTransport 仅支持 stdio 配置，收到 ${config.type}`);
	}
	return createStdioHandle(config, workspaceCwd);
}

/** 构造 STDIO Handle：创建 StdioClientTransport 并有界收集 stderr。 */
function createStdioHandle(config: StdioMcpRuntimeConfig, workspaceCwd?: string): McpTransportHandle {
	const cwd = config.cwd ?? workspaceCwd;
	const transport = new StdioClientTransport({
		command: config.command,
		args: [...config.args],
		env: { ...config.env },
		stderr: 'pipe',
		...(cwd !== undefined ? { cwd } : {}),
	});

	// PassThrough 流在构造时即返回，附加 data 监听后进入流动模式，有界保留尾部
	let stderrTail = '';
	const stderrStream = transport.stderr;
	if (stderrStream !== null) {
		stderrStream.on('data', (chunk: Buffer) => {
			stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_MAX_BYTES);
		});
	}

	return {
		transport,
		actualTransport: 'stdio',
		stderrTail: () => stderrTail,
		close: () => transport.close(),
	};
}

/**
 * 创建 Streamable HTTP Transport Handle（任务 8.3）。
 *
 * 静态 headers（来自 SecretStorage）只注入到同 origin 请求；跨 origin redirect
 * 被拒绝以防 header 泄漏到非预期 origin。关闭时若存在 stateful session 先调用
 * terminateSession（有界），再关闭 Transport。
 *
 * @param config 运行时配置（headers 已装配）；非 streamable-http 类型抛错
 * @returns Streamable HTTP Transport Handle
 */
export function createStreamableHttpTransport(config: McpServerRuntimeConfig): McpTransportHandle {
	if (config.type !== 'streamable-http') {
		throw new Error(`createStreamableHttpTransport 仅支持 streamable-http 配置，收到 ${config.type}`);
	}
	return createStreamableHandle(config);
}

/** 构造 Streamable HTTP Handle：注入静态 headers、拒绝跨 origin redirect、有界 session 终止。 */
function createStreamableHandle(config: StreamableHttpMcpRuntimeConfig): McpTransportHandle {
	const url = new URL(config.url);
	const origin = `${url.protocol}//${url.host}`;

	const transport = new StreamableHTTPClientTransport(url, {
		requestInit: {
			headers: { ...config.headers },
		},
		// 自定义 fetch：拒绝跨 origin redirect，防止配置 headers 泄漏到非预期 origin
		fetch: async (input: URL | RequestInfo, init?: RequestInit) => {
			const mergedInit: RequestInit = { ...init, redirect: 'manual' };
			const response = await fetch(input, mergedInit);
			// 3xx redirect：检查 Location origin
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get('location');
				if (location) {
					let redirectUrl: URL;
					try {
						redirectUrl = new URL(location, typeof input === 'string' ? input : input instanceof URL ? input : input.url);
					} catch {
						redirectUrl = new URL(location);
					}
					const redirectOrigin = `${redirectUrl.protocol}//${redirectUrl.host}`;
					if (redirectOrigin !== origin) {
						throw new Error(`MCP 跨 origin 重定向被拒绝：${origin} → ${redirectOrigin}`);
					}
				}
			}
			return response;
		},
	});

	return {
		transport,
		actualTransport: 'streamable-http',
		close: async () => {
			// stateful session：先有界 terminateSession，再关闭 Transport
			const httpTransport = transport as StreamableHTTPClientTransport;
			if (httpTransport.sessionId) {
				try {
					await withTimeout(httpTransport.terminateSession(), TERMINATE_SESSION_TIMEOUT_MS);
				} catch {
					// terminateSession 失败不阻塞关闭
				}
			}
			await transport.close();
		},
	};
}

/**
 * 创建 Legacy SSE Transport Handle（任务 8.8）。
 *
 * 用于 Streamable HTTP 兼容失败时的 SSE 回退。构造 SSEClientTransport 连接到
 * 同 origin 的 /sse 端点（从 /mcp 推导），注入与 Streamable HTTP 相同的静态 headers。
 *
 * @param config 运行时配置（headers 已装配）；非 streamable-http 类型抛错
 * @returns Legacy SSE Transport Handle
 */
export function createLegacySseTransport(config: McpServerRuntimeConfig): McpTransportHandle {
	if (config.type !== 'streamable-http') {
		throw new Error(`createLegacySseTransport 仅支持 streamable-http 配置，收到 ${config.type}`);
	}
	return createSseHandle(config);
}

/** 构造 Legacy SSE Handle：从 /mcp URL 推导 /sse 端点，注入静态 headers。 */
function createSseHandle(config: StreamableHttpMcpRuntimeConfig): McpTransportHandle {
	const mcpUrl = new URL(config.url);
	// SSE 端点：同 origin + /sse
	const sseUrl = new URL('/sse', mcpUrl);

	const transport = new SSEClientTransport(sseUrl, {
		requestInit: {
			headers: { ...config.headers },
		},
	});

	return {
		transport,
		actualTransport: 'legacy-sse',
		close: () => transport.close(),
	};
}

/** 给 Promise 套一个有界超时，超时后 resolve（不 reject），避免卡死。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | void> {
	return new Promise<T | void>((resolve) => {
		let done = false;
		const timer = setTimeout(() => {
			if (!done) { done = true; resolve(undefined); }
		}, timeoutMs);
		promise.then((v) => {
			if (!done) { done = true; clearTimeout(timer); resolve(v); }
		}, () => {
			if (!done) { done = true; clearTimeout(timer); resolve(undefined); }
		});
	});
}
