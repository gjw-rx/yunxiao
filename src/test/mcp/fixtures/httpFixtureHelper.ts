/**
 * HTTP fixture Server 生命周期管理助手（任务 8.1 测试基础设施）。
 *
 * 职责：以指定环境变量启动 out/test/mcp/fixtures/httpServer.js 子进程，
 * 从 stdout 读取 `HTTP_FIXTURE_PORT=<port>`，提供 base URL 与有界关闭。
 *
 * 用法：
 * ```ts
 * const fixture = await startHttpFixture({ MCP_HTTP_MODE: 'streamable' });
 * // ... 使用 fixture.baseUrl ...
 * await fixture.close();
 * ```
 */
import * as childProcess from 'child_process';
import * as path from 'node:path';

/** 编译后 fixture 路径（与本 helper 同目录）。 */
const FIXTURE_PATH = path.join(__dirname, 'httpServer.js');

/** HTTP fixture 句柄。 */
export interface HttpFixtureHandle {
	/** 实际监听地址（http://127.0.0.1:<port>）。 */
	readonly baseUrl: string;
	/** 实际端口。 */
	readonly port: number;
	/** 读取 stderr 尾部（有界，用于 header 检查 / call count 验证）。 */
	readonly stderrTail: () => string;
	/** 关闭子进程（有界 SIGTERM + SIGKILL）。 */
	close(): Promise<void>;
}

/** 等待毫秒。 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 启动 HTTP fixture 子进程并读取端口。
 *
 * @param env 环境变量（MCP_HTTP_MODE 等）
 * @param timeoutMs 等待端口输出的超时（默认 5000ms）
 * @returns fixture 句柄
 */
export function startHttpFixture(env: Record<string, string> = {}, timeoutMs = 5000): Promise<HttpFixtureHandle> {
	return new Promise((resolve, reject) => {
		const fullEnv = { ...process.env, ...env };
		const proc = childProcess.spawn('node', [FIXTURE_PATH], {
			env: fullEnv,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let stdoutBuf = '';
		let stderrBuf = '';
		let resolved = false;
		const timer = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				try { proc.kill('SIGKILL'); } catch { /* 忽略 */ }
				reject(new Error(`HTTP fixture 启动超时（${timeoutMs}ms），stdout=${stdoutBuf} stderr=${stderrBuf}`));
			}
		}, timeoutMs);

		proc.stdout.on('data', (chunk: Buffer) => {
			stdoutBuf += chunk.toString('utf8');
			const match = stdoutBuf.match(/HTTP_FIXTURE_PORT=(\d+)/);
			if (match && !resolved) {
				resolved = true;
				clearTimeout(timer);
				const port = parseInt(match[1], 10);
				resolve({
					baseUrl: `http://127.0.0.1:${port}`,
					port,
					stderrTail: () => stderrBuf.slice(-8192),
					close: async () => {
						clearTimeout(timer);
						try { proc.kill('SIGTERM'); } catch { /* 忽略 */ }
						// 有界等待退出
						await sleep(200);
						try {
							if (!proc.killed) { proc.kill('SIGKILL'); }
						} catch { /* 忽略 */ }
					},
				});
			}
		});

		proc.stderr.on('data', (chunk: Buffer) => {
			stderrBuf += chunk.toString('utf8');
			// 有界保留尾部
			if (stderrBuf.length > 16384) {
				stderrBuf = stderrBuf.slice(-8192);
			}
		});

		proc.on('error', (err) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
				reject(new Error(`HTTP fixture 启动失败: ${err.message}`));
			}
		});

		proc.on('exit', (code) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
				reject(new Error(`HTTP fixture 意外退出 code=${code} stderr=${stderrBuf}`));
			}
		});
	});
}
