import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import type { ToolResult, ToolSchema } from './core/types';

/** 云端持久化 Run 的最小快照。 */
export interface RunInfo {
	run_id: string;
	session_id: string;
	status: 'pending' | 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
}

/** 云端 Run 事件。content 事件的 sequence 为 null（瞬态，不落库）；其他事件为单调递增整数。 */
export interface RunEvent {
	sequence: number | null;
	type: string;
	payload: unknown;
}

/** v2 SSE 信封结构：{sequence, event_type, payload: {type, data}}。content 的 sequence 为 null。 */
interface RunEventEnvelope {
	sequence?: number | null;
	event_type?: string;
	type?: string;
	payload?: unknown;
}

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

export interface ManualCompressResponse {
	session_id: string;
	compressed: boolean;
	before_count: number;
	after_count: number;
	pruned_count: number;
	summary_token_budget: number;
	compress_count: number;
	trigger: 'manual';
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

// ---------- 通用 JSON 请求 ----------

function request<T>(
	baseUrl: string,
	path: string,
	method: string,
	body?: unknown,
	timeoutMs?: number,
): Promise<T> {
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
		if (timeoutMs) {
			req.setTimeout(timeoutMs, () => {
				req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
			});
		}
		if (payload) {
			req.write(payload);
		}
		req.end();
	});
}

// ---------- AIClient ----------

export class AIClient {
	constructor(private baseUrl: string) { }

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

	/** 手动压缩指定会话的上下文；服务端要求 Run 进入终态后调用。 */
	compressSession(sessionId: string): Promise<ManualCompressResponse> {
		const encodedSessionId = encodeURIComponent(sessionId);
		return request<ManualCompressResponse>(
			this.baseUrl,
			`/api/compress/sessions/${encodedSessionId}/compress`,
			'POST',
			undefined,
			60_000,
		);
	}

	/** 创建 v2 持久化 Run；调用方随后以事件订阅消费计算结果。 */
	createRun(sessionId: string, text: string, clientRequestId: string): Promise<RunInfo> {
		return request<RunInfo>(this.baseUrl, '/api/v2/agent/run', 'POST', {
			session_id: sessionId,
			text,
			client_request_id: clientRequestId,
		});
	}

	/** 向指定 Run 提交本地工具结果，触发续算。返回 JSON（非 SSE）。 */
	submitRunToolResult(runId: string, results: ToolResult[]): Promise<void> {
		return request<void>(this.baseUrl, `/api/v2/agent/run/${encodeURIComponent(runId)}/tool-result`, 'POST', { results });
	}

	/** 从排他游标订阅 v2 Run 事件。SSE 流结束时调用 onEnd，断线恢复由调用方使用同一游标重新订阅。 */
	subscribeRun(
		runId: string,
		afterSequence: number,
		onEvent: (event: RunEvent) => void,
		onError: (error: Error) => void,
		onEnd: () => void,
	): AbortController {
		const controller = new AbortController();
		const url = `${this.baseUrl}/api/v2/agent/run/${encodeURIComponent(runId)}/events?after_sequence=${afterSequence}`;
		fetch(url, { headers: { Accept: 'text/event-stream' }, signal: controller.signal })
			.then(async (response) => {
				if (!response.ok || !response.body) { throw new Error(`服务返回状态码 ${response.status}`); }
				const reader = response.body.getReader();
				const decoder = new TextDecoder('utf-8');
				let buffer = '';
				while (!controller.signal.aborted) {
					const { done, value } = await reader.read();
					if (done) { break; }
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';
					for (const line of lines) {
						if (line.startsWith('data:')) {
							this.dispatchSseLine(line.slice(5).trim(), onEvent, onError);
						}
					}
				}
				// flush 剩余缓冲（服务端可能未以 \n\n 结尾）
				if (!controller.signal.aborted && buffer.trim().startsWith('data:')) {
					this.dispatchSseLine(buffer.slice(5).trim(), onEvent, onError);
				}
				if (!controller.signal.aborted) {
					onEnd();
				}
			})
			.catch((error: Error) => { if (error.name !== 'AbortError') { onError(error); } });
		return controller;
	}

	/** 解析单条 SSE data 行并分发。content 事件的 sequence 为 null（瞬态），其他事件为整数。 */
	private dispatchSseLine(
		jsonStr: string,
		onEvent: (event: RunEvent) => void,
		onError: (error: Error) => void,
	): void {
		if (!jsonStr) { return; }
		try {
			const envelope = JSON.parse(jsonStr) as RunEventEnvelope;
			const eventType = envelope.event_type ?? envelope.type;
			// sequence 为 null（content 瞬态事件）或 number（持久事件）；event_type 必须为 string
			if (typeof eventType !== 'string' || (envelope.sequence !== null && typeof envelope.sequence !== 'number')) {
				throw new Error('Run 事件格式不合法');
			}
			onEvent({
				sequence: envelope.sequence ?? null,
				type: eventType,
				payload: envelope.payload,
			});
		} catch (err) {
			onError(err instanceof Error ? err : new Error(String(err)));
		}
	}
}
