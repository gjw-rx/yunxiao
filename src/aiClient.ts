import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { SseStreamParser, type SseCallbacks } from './protocol/sseHandler';
import { streamToolResult } from './protocol/toolCallProtocol';
import type { ToolResult, ToolSchema } from './core/types';

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

interface SessionResult {
	session_id: string;
	agent_id: string;
}

/** 流式回调（与 sseHandler.SseCallbacks 一致，含 Phase 1 新增 onToolCall/onPlan/onProgress）。 */
export type StreamCallbacks = SseCallbacks;

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

// ---------- AIClient ----------

export class AIClient {
	constructor(private baseUrl: string) {}

	listAgents(): Promise<AgentInfo[]> {
		return request<AgentInfo[]>(this.baseUrl, '/api/agent/config', 'GET');
	}

	/** 创建会话；可一并上报本地工具 schema 和工作区根目录给云端装配。 */
	createSession(agentId: string, localTools?: ToolSchema[], workspaceRoot?: string): Promise<SessionResult> {
		const body: Record<string, unknown> = { agent_id: agentId };
		if (localTools && localTools.length > 0) {
			body.local_tools = localTools;
		}
		if (workspaceRoot) {
			body.workspace_root = workspaceRoot;
		}
		return request<SessionResult>(this.baseUrl, '/api/agent/invoke/session', 'POST', body);
	}

	getHistory(sessionId: string, offset = 0, limit = 50): Promise<MessageInfo[]> {
		const qs = `?session_id=${encodeURIComponent(sessionId)}&offset=${offset}&limit=${limit}`;
		return request<MessageInfo[]>(this.baseUrl, `/api/agent/invoke/history${qs}`, 'GET');
	}

	/** 流式发消息，返回 AbortController 用于中断。事件经 SseStreamParser 解析后分发到回调。 */
	streamMessage(sessionId: string, text: string, cbs: SseCallbacks): AbortController {
		return this.openSseStream(
			'/api/agent/invoke/message/stream',
			{ session_id: sessionId, text },
			cbs
		);
	}

	/** 批量提交工具结果并读取续流，返回 AbortController 用于中断。 */
	submitToolResult(results: ToolResult[], sessionId: string, cbs: SseCallbacks): AbortController {
		return streamToolResult(results, sessionId, { baseUrl: this.baseUrl }, cbs);
	}

	/** 通用：POST 一个 SSE 端点并读取流，分发到回调。 */
	private openSseStream(
		pathStr: string,
		body: unknown,
		cbs: SseCallbacks
	): AbortController {
		const controller = new AbortController();
		const url = `${this.baseUrl}${pathStr}`;

		fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'text/event-stream',
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		})
			.then(async (res) => {
				if (!res.ok) {
					try {
						const parsed = (await res.json()) as ApiResponse<unknown>;
						cbs.onError?.(new Error(parsed.error ?? `服务返回状态码 ${res.status}`));
					} catch {
						cbs.onError?.(new Error(`服务返回状态码 ${res.status}`));
					}
					return;
				}

				// Content-Type 为 application/json 表示流建立前失败（如会话不存在）
				const ct = res.headers.get('content-type') ?? '';
				if (ct.includes('application/json')) {
					try {
						const parsed = (await res.json()) as ApiResponse<unknown>;
						cbs.onError?.(new Error(parsed.error ?? '请求失败'));
					} catch {
						cbs.onError?.(new Error('响应解析失败'));
					}
					return;
				}

				if (!res.body) {
					cbs.onError?.(new Error('不支持 ReadableStream'));
					return;
				}

				const reader = res.body.getReader();
				const decoder = new TextDecoder('utf-8');
				const parser = new SseStreamParser(cbs);

				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					parser.feed(decoder.decode(value, { stream: true }));
					if (controller.signal.aborted) {
						break;
					}
				}
				if (!controller.signal.aborted) {
					parser.flush();
					cbs.onEnd?.();
				}
			})
			.catch((err: Error) => {
				// AbortError 静默处理（用户主动中断）
				if (err.name !== 'AbortError') {
					cbs.onError?.(err);
				}
			});

		return controller;
	}
}
