import * as assert from 'assert';
import * as http from 'http';
import { AIClient } from '../aiClient';
import type { ToolSchema } from '../core/types';

/** Mock 服务端：覆盖 config/session/history/message-stream/tool_result 路由。 */
class MockServer {
	private server!: http.Server;
	port = 0;
	readonly sessionBodies: Record<string, unknown>[] = [];
	/** /message/stream 行为：'sse' 正常流 | 'httpError' 返回错误状态 | 'jsonError' 返回 JSON 错误信封。 */
	messageMode: 'sse' | 'httpError' | 'jsonError' = 'sse';

	start(): Promise<void> {
		return new Promise((resolve) => {
			this.server = http.createServer((req, res) => this.handle(req, res));
			this.server.listen(0, '127.0.0.1', () => {
				this.port = (this.server.address() as { port: number }).port;
				resolve();
			});
		});
	}
	get baseUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}
	close(): Promise<void> {
		return new Promise((r) => this.server.close(() => r()));
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
			if (req.url === '/api/agent/config' && req.method === 'GET') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ success: true, data: [{ agent_id: 'a1', agent_name: 'A1' }] }));
				return;
			}
			if (req.url === '/api/agent/invoke/session' && req.method === 'POST') {
				this.sessionBodies.push(parsed);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ success: true, data: { session_id: 's1', agent_id: 'a1' } }));
				return;
			}
			if (req.url?.startsWith('/api/agent/invoke/history') && req.method === 'GET') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ success: true, data: [] }));
				return;
			}
			if (req.url === '/api/agent/invoke/message/stream' && req.method === 'POST') {
				if (this.messageMode === 'httpError') {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ success: false, error: '服务内部错误' }));
					return;
				}
				if (this.messageMode === 'jsonError') {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ success: false, error: '会话不存在' }));
					return;
				}
				res.writeHead(200, { 'Content-Type': 'text/event-stream' });
				res.write('data: {"type":"content","data":"hi"}\n\n');
				res.end();
				return;
			}
			if (req.url === '/api/agent/invoke/tool_result' && req.method === 'POST') {
				res.writeHead(200, { 'Content-Type': 'text/event-stream' });
				res.write('data: {"type":"content","data":"summary"}\n\n');
				res.end();
				return;
			}
			res.writeHead(404);
			res.end();
		});
	}
}

const LOCAL_TOOL: ToolSchema = {
	name: 'fs.read_file',
	description: 'd',
	parameters: { type: 'object' },
	permissions: 'read',
	site: 'local',
};

describe('AIClient', () => {
	let mock: MockServer;
	let client: AIClient;

	beforeEach(async () => {
		mock = new MockServer();
		await mock.start();
		client = new AIClient(mock.baseUrl);
	});
	afterEach(async () => {
		await mock.close();
	});

	it('listAgents returns agents', async () => {
		const agents = await client.listAgents();
		assert.strictEqual(agents.length, 1);
		assert.strictEqual(agents[0].agent_id, 'a1');
	});

	it('createSession sends local_tools and workspace_root when provided', async () => {
		await client.createSession('a1', [LOCAL_TOOL], 'D:\\workspace');
		assert.strictEqual(mock.sessionBodies.length, 1);
		assert.deepStrictEqual(mock.sessionBodies[0].local_tools, [LOCAL_TOOL]);
		assert.strictEqual(mock.sessionBodies[0].agent_id, 'a1');
		assert.strictEqual(mock.sessionBodies[0].workspace_root, 'D:\\workspace');
	});

	it('createSession omits optional context when not provided (backward compat)', async () => {
		await client.createSession('a1');
		assert.strictEqual(mock.sessionBodies.length, 1);
		assert.strictEqual('local_tools' in mock.sessionBodies[0], false);
		assert.strictEqual('workspace_root' in mock.sessionBodies[0], false);
	});

	it('getHistory returns messages', async () => {
		const history = await client.getHistory('s1');
		assert.deepStrictEqual(history, []);
	});

	it('streamMessage parses content and ends', async () => {
		const contents: string[] = [];
		let ended = false;
		client.streamMessage('s1', 'hello', {
			onContent: (t) => contents.push(t),
			onEnd: () => {
				ended = true;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepStrictEqual(contents, ['hi']);
		assert.strictEqual(ended, true);
	});

	it('streamMessage reports http error via onError', async () => {
		mock.messageMode = 'httpError';
		const errors: string[] = [];
		client.streamMessage('s1', 'hello', { onError: (e) => errors.push(e.message) });
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.ok(errors.some((m) => m.includes('服务内部错误')));
	});

	it('streamMessage reports json error envelope via onError', async () => {
		mock.messageMode = 'jsonError';
		const errors: string[] = [];
		client.streamMessage('s1', 'hello', { onError: (e) => errors.push(e.message) });
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.ok(errors.some((m) => m.includes('会话不存在')));
	});

	it('submitToolResult pumps the continuation stream', async () => {
		const contents: string[] = [];
		let ended = false;
		client.submitToolResult(
			[{ call_id: 'c1', status: 'success', result: 'x' }],
			's1',
			{
				onContent: (t) => contents.push(t),
				onEnd: () => {
					ended = true;
				},
			}
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepStrictEqual(contents, ['summary']);
		assert.strictEqual(ended, true);
	});
});
