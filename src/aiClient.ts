import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

// ---------- 类型定义 ----------

export interface AgentInfo {
	agent_id: string;
	agent_name: string;
	agent_desc: string;
	model?: string;
	memory_enabled?: boolean;
}

export interface MessageInfo {
	id: number;
	session_id: string;
	role: string;
	content: string;
	seq: number;
	create_time: string;
}

interface ApiResponse<T> {
	success: boolean;
	data?: T;
	error?: string;
	message?: string;
}

export interface StreamCallbacks {
	onContent: (text: string) => void;
	onThought?: (text: string) => void;
	onToolStart?: (toolName: string) => void;
	onToolEnd?: (output: string) => void;
	onEnd: () => void;
	onError: (err: Error) => void;
}

interface SessionResult {
	session_id: string;
	agent_id: string;
}

// ---------- 通用 JSON 请求 ----------

function request<T>(baseUrl: string, path: string, method: string, body?: unknown): Promise<T> {
	return new Promise((resolve, reject) => {
		const url = new URL(path, baseUrl);
		const lib = url.protocol === 'https:' ? https : http;
		const payload = body ? JSON.stringify(body) : undefined;

		const req = lib.request(
			{
				hostname: url.hostname,
				port: url.port,
				path: url.pathname + url.search,
				method,
				headers: payload
					? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
					: undefined,
			},
			(res) => {
				let data = '';
				res.on('data', (chunk: string) => (data += chunk));
				res.on('end', () => {
					try {
						const parsed: ApiResponse<T> = JSON.parse(data);
						if (!parsed.success) {
							reject(new Error(parsed.error ?? parsed.message ?? '请求失败'));
							return;
						}
						resolve(parsed.data as T);
					} catch {
						reject(new Error(`响应解析失败: ${data.slice(0, 200)}`));
					}
				});
			}
		);

		req.on('error', (err) => reject(err));
		if (payload) {
			req.write(payload);
		}
		req.end();
	});
}

// ---------- SSE 解析 ----------

function handleSseBlock(block: string, cbs: StreamCallbacks): void {
	for (const line of block.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('data:')) {
			continue;
		}
		const jsonStr = trimmed.slice(5).trim();
		if (!jsonStr) {
			continue;
		}
		try {
			const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

			// 流中错误信封：{ success: false, error: "..." }
			if (parsed.success === false) {
				cbs.onError(new Error((parsed.error as string) ?? '流式请求失败'));
				return;
			}

			const evtType = parsed.type as string | undefined;
			const evtData = parsed.data as string | undefined;

			switch (evtType) {
				case 'content':
					if (typeof evtData === 'string') {
						cbs.onContent(evtData);
					}
					break;
				case 'thought':
					if (typeof evtData === 'string' && cbs.onThought) {
						cbs.onThought(evtData);
					}
					break;
				case 'tool_start':
					if (typeof evtData === 'string' && cbs.onToolStart) {
						cbs.onToolStart(evtData);
					}
					break;
				case 'tool_end':
					if (typeof evtData === 'string' && cbs.onToolEnd) {
						cbs.onToolEnd(evtData);
					}
					break;
			}
		} catch {
			// 非 JSON 行，忽略
		}
	}
}

// ---------- AIClient ----------

export class AIClient {
	constructor(private baseUrl: string) {}

	listAgents(): Promise<AgentInfo[]> {
		return request<AgentInfo[]>(this.baseUrl, '/api/agent/config', 'GET');
	}

	createSession(agentId: string): Promise<SessionResult> {
		return request<SessionResult>(this.baseUrl, '/api/agent/invoke/session', 'POST', {
			agent_id: agentId,
		});
	}

	getHistory(sessionId: string, offset = 0, limit = 50): Promise<MessageInfo[]> {
		const qs = `?session_id=${encodeURIComponent(sessionId)}&offset=${offset}&limit=${limit}`;
		return request<MessageInfo[]>(this.baseUrl, `/api/agent/invoke/history${qs}`, 'GET');
	}

	/** 流式发消息，返回 AbortController 用于中断 */
	streamMessage(
		body: { session_id: string; text: string },
		cbs: StreamCallbacks
	): AbortController {
		const controller = new AbortController();
		const url = `${this.baseUrl}/api/agent/invoke/message/stream`;

		// 使用 fetch + ReadableStream（与浏览器端一致的 SSE 解析模式）
		fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'text/event-stream',
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		})
			.then(async (res) => {
				if (!res.ok) {
					try {
						const parsed = await res.json() as ApiResponse<unknown>;
						cbs.onError(new Error(parsed.error ?? `服务返回状态码 ${res.status}`));
					} catch {
						cbs.onError(new Error(`服务返回状态码 ${res.status}`));
					}
					return;
				}

				// 检查 Content-Type：application/json 表示流建立前失败（如会话不存在）
				const ct = res.headers.get('content-type') ?? '';
				if (ct.includes('application/json')) {
					try {
						const parsed = await res.json() as ApiResponse<unknown>;
						cbs.onError(new Error(parsed.error ?? '请求失败'));
					} catch {
						cbs.onError(new Error('响应解析失败'));
					}
					return;
				}

				if (!res.body) {
					cbs.onError(new Error('不支持 ReadableStream'));
					return;
				}

				const reader = res.body.getReader();
				const decoder = new TextDecoder('utf-8');
				let buffer = '';

				// SSE 以 \n\n 分隔事件，逐块解析
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}

					buffer += decoder.decode(value, { stream: true });

					let sep: number;
					while ((sep = buffer.indexOf('\n\n')) !== -1) {
						const rawEvent = buffer.slice(0, sep);
						buffer = buffer.slice(sep + 2);
						handleSseBlock(rawEvent, cbs);
					}
				}

				// 处理缓冲区剩余
				if (buffer.trim()) {
					handleSseBlock(buffer, cbs);
				}
				cbs.onEnd();
			})
			.catch((err: Error) => {
				if (err.name !== 'AbortError') {
					cbs.onError(err);
				}
			});

		return controller;
	}
}
