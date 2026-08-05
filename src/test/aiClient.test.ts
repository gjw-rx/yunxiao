import * as assert from 'assert';
import * as http from 'http';
import { AIClient } from '../aiClient';
import type { ToolSchema } from '../core/types';

/** Mock 服务端：覆盖 config/session/history/run/tool-result/events 路由。 */
class MockServer {
	private server!: http.Server;
	port = 0;
	readonly sessionBodies: Record<string, unknown>[] = [];
	readonly runBodies: Record<string, unknown>[] = [];
	readonly toolResultBodies: Record<string, unknown>[] = [];
	lastRunEventsUrl?: string;

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
			if (req.url === '/api/v2/agent/run' && req.method === 'POST') {
				this.runBodies.push(parsed);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ success: true, data: { run_id: 'r1', session_id: 's1', status: 'running' } }));
				return;
			}
			if (req.url === '/api/v2/agent/run/r1/tool-result' && req.method === 'POST') {
				this.toolResultBodies.push(parsed);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ success: true, data: { run_id: 'r1', status: 'running' } }));
				return;
			}
			if (req.url?.startsWith('/api/v2/agent/run/r1/events') && req.method === 'GET') {
				this.lastRunEventsUrl = req.url;
				res.writeHead(200, { 'Content-Type': 'text/event-stream' });
				// v2.1 信封格式：content 事件 sequence 为 null（瞬态，不落库）
				res.write('data: {"sequence":null,"event_type":"content","payload":{"type":"content","data":"hi"}}\n\n');
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

	it('creates a v2 Run with an idempotency key', async () => {
		const run = await client.createRun('s1', 'hello', 'request-1');
		assert.strictEqual(run.run_id, 'r1');
		assert.deepStrictEqual(mock.runBodies[0], { session_id: 's1', text: 'hello', client_request_id: 'request-1' });
	});

	it('submits tool results and receives JSON response', async () => {
		await client.submitRunToolResult('r1', [{ call_id: 'c1', status: 'success', result: 'x' }]);
		assert.strictEqual(mock.toolResultBodies.length, 1);
		assert.deepStrictEqual(mock.toolResultBodies[0].results, [{ call_id: 'c1', status: 'success', result: 'x' }]);
	});

	it('subscribes to a Run after the supplied exclusive cursor and parses v2 envelope', async () => {
		const event = await new Promise<{ sequence: number | null; type: string; payload: unknown }>((resolve, reject) => {
			client.subscribeRun('r1', 2, resolve, reject, () => { });
		});
		// v2.1: content 事件 sequence 为 null
		assert.strictEqual(event.sequence, null);
		assert.strictEqual(event.type, 'content');
		assert.strictEqual(mock.lastRunEventsUrl, '/api/v2/agent/run/r1/events?after_sequence=2');
		// 验证 payload 是 {type, data} 结构
		const payload = event.payload as { type: string; data: string };
		assert.strictEqual(payload.type, 'content');
		assert.strictEqual(payload.data, 'hi');
	});

	it('calls onEnd when the SSE stream finishes', async () => {
		let ended = false;
		await new Promise<void>((resolve) => {
			client.subscribeRun('r1', 2, () => { }, () => { }, () => {
				ended = true;
				resolve();
			});
		});
		assert.strictEqual(ended, true);
	});
});
