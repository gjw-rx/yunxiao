/**
 * 会话文件存储 - 将会话消息持久化到 ~/.yunForce/projects/<workspace 编码>/ 目录。
 * 参照 Claude Code 存储范式：每个会话一个 JSONL 文件（一行一条消息，追加写），
 * index.json 维护会话索引（标题/时间/消息数），支持原子替换与坏行容忍。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { ArchiveEntry, Message, SessionHeader, SessionRecord, TokenUsageSnapshot } from './types';
import { SESSION_ARCHIVE_VERSION } from './types';
import type { TodoSnapshot } from './todoTypes';
import type { SessionPlanState, SessionPlanStateRecord } from './planTypes';
import { loadArchive, projectActiveMessages, validateArchive } from './sessionArchive';
import * as logger from '../logger';

/** 会话元数据（索引条目） */
export interface SessionMeta {
	/** 会话 ID（UUID） */
	readonly sessionId: string;
	/** 展示标题：首条用户消息截断或自定义名 */
	readonly title: string;
	/** 创建时间（ISO 字符串） */
	readonly createdAt: string;
	/** 最近活动时间（ISO 字符串） */
	readonly updatedAt: string;
	/** 消息条数 */
	readonly messageCount: number;
	/** 标题是否为用户自定义（自定义后不再被首条消息覆盖） */
	readonly customTitle: boolean;
}

/** 归档中一次已落账 LLM 调用的 token 账记录（供用量统计扫描使用）。 */
export interface ArchivedTokenRecord {
	/** 所属会话 ID */
	readonly sessionId: string;
	/** 该调用归档 entry 的落账时间（ISO 字符串，分桶时间） */
	readonly timestamp: string;
	/** assistant 消息的 token 账快照（含非敏感模型元数据；旧归档可能缺失） */
	readonly tokenUsage: TokenUsageSnapshot;
}

/** 会话索引文件结构 */
export interface SessionIndex {
	readonly version: 1;
	/** 所属 workspace 根路径（原始） */
	readonly workspacePath: string;
	/** 当前活跃会话 ID */
	readonly currentSessionId?: string;
	/** sessionId -> 元数据 */
	readonly sessions: Record<string, SessionMeta>;
	/** sessionId -> 最新任务快照。 */
	readonly todos?: Record<string, TodoSnapshot>;
	/** sessionId -> Plan 模式状态（可选；旧索引缺失时按 normal 处理）。 */
	readonly planStates?: SessionPlanStateRecord;
	/** sessionId -> 活动位置 Entry ID 缓存（可从归档重建，非唯一来源）。 */
	readonly heads?: Record<string, string>;
}

/** 内部可变索引（SessionIndex 的写版本，供 mutateIndex 修改） */
type MutableSessionIndex = {
	version: 1;
	workspacePath: string;
	currentSessionId?: string;
	sessions: Record<string, SessionMeta>;
	todos: Record<string, TodoSnapshot>;
	planStates: SessionPlanStateRecord;
	heads: Record<string, string>;
};

/** 默认标题长度上限（字符） */
export const TITLE_MAX = 40;

/** index.json 文件名 */
const INDEX_FILE = 'index.json';

/** 任务状态的合法取值集合。 */
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

/** Plan 阶段合法取值集合。 */
const PLAN_STAGES = new Set(['normal', 'planning', 'review', 'executing']);

/**
 * 将索引中的 Plan 状态转换为可用结构；缺失或非法值按 normal 回退，不阻塞历史加载。
 * @param value 原始索引字段。
 * @returns 会话 Plan 状态映射。
 */
function parsePlanStates(value: unknown): SessionPlanStateRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}

	const states: SessionPlanStateRecord = {};
	for (const [sessionId, rawState] of Object.entries(value)) {
		if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
			continue;
		}
		const raw = rawState as { stage?: unknown; draftCreated?: unknown };
		// stage 非法视为整条状态损坏，整体回退 normal（含草案标记），不阻塞历史加载。
		if (typeof raw.stage !== 'string' || !PLAN_STAGES.has(raw.stage)) {
			states[sessionId] = { stage: 'normal', draftCreated: false };
			continue;
		}
		states[sessionId] = {
			stage: raw.stage as SessionPlanState['stage'],
			draftCreated: raw.draftCreated === true,
		};
	}
	return states;
}

/**
 * 将索引中的任务快照转换为可用结构；损坏项按空快照处理。
 * @param value 原始索引字段。
 * @returns 会话任务快照映射。
 */
function parseTodoSnapshots(value: unknown): Record<string, TodoSnapshot> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}

	const snapshots: Record<string, TodoSnapshot> = {};
	for (const [sessionId, rawSnapshot] of Object.entries(value)) {
		if (!rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)) {
			continue;
		}
		const rawTodos = (rawSnapshot as { todos?: unknown }).todos;
		if (!Array.isArray(rawTodos)) {
			snapshots[sessionId] = { todos: [] };
			continue;
		}
		const uniqueIds = new Set<string>();
		const todos: TodoSnapshot['todos'][number][] = [];
		for (const rawTodo of rawTodos) {
			if (!rawTodo || typeof rawTodo !== 'object' || Array.isArray(rawTodo)) {
				continue;
			}
			const todo = rawTodo as { id?: unknown; content?: unknown; status?: unknown };
			if (
				typeof todo.id !== 'string' ||
				typeof todo.content !== 'string' ||
				typeof todo.status !== 'string' ||
				!TODO_STATUSES.has(todo.status) ||
				uniqueIds.has(todo.id)
			) {
				continue;
			}
			uniqueIds.add(todo.id);
			todos.push({ id: todo.id, content: todo.content, status: todo.status as TodoSnapshot['todos'][number]['status'] });
		}
		snapshots[sessionId] = {
			todos: todos.filter((todo) => todo.status === 'in_progress').length <= 1 ? todos : [],
		};
	}
	return snapshots;
}

/**
 * workspace 根路径编码为目录名：除字母/数字/连字符外的字符（含 `/`、`_`、非 ASCII）
 * 全部替换为 `-`，与 Claude Code 的 projects 目录命名规则一致。
 * @param workspacePath workspace 根绝对路径
 * @returns 编码后的目录名
 */
export function encodeWorkspacePath(workspacePath: string): string {
	return workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * 从用户消息内容生成默认标题：去除首尾空白、折叠换行、截断至 TITLE_MAX。
 * @param content 用户消息文本
 * @returns 标题文本
 */
export function deriveTitle(content: string): string {
	const normalized = content.replace(/\s+/g, ' ').trim();
	if (normalized.length <= TITLE_MAX) {
		return normalized;
	}
	return `${normalized.slice(0, TITLE_MAX)}…`;
}

export class SessionFileStore {
	/** 当前 workspace 的会话目录（projects/<编码>） */
	private readonly sessionDir: string;
	/** workspace 根路径（写入 v2 header 用） */
	private readonly workspacePath: string;
	/** 索引内存缓存（可变写版本） */
	private index: MutableSessionIndex;
	/** 写操作串行链，保证落盘顺序 */
	private writeChain: Promise<void> = Promise.resolve();
	/** 待提交写操作集合（commit 结算后清理） */
	private readonly pendingCommits: Array<{ promise: Promise<void>; sessionId?: string }> = [];
	/** 索引变更监听器（新建/追加/删除/重命名/切换时触发） */
	private readonly changeListeners = new Set<() => void>();

	/**
	 * @param workspacePath workspace 根路径（用于目录编码与索引记录）
	 * @param baseDir 存储根目录，默认 ~/.yunForce/projects（测试可注入临时目录）
	 */
	constructor(workspacePath: string, baseDir?: string) {
		const root = baseDir ?? path.join(os.homedir(), '.yunForce', 'projects');
		this.workspacePath = workspacePath;
		this.sessionDir = path.join(root, encodeWorkspacePath(workspacePath));
		this.index = this.loadIndex(workspacePath);
		this.reconcileIndexFromArchives();
		logger.log(`[SessionFileStore] 初始化 sessionDir=${this.sessionDir} 会话数=${this.listSessions().length}`);
	}

	/** 当前会话目录路径（测试/调试用）。 */
	get sessionDirPath(): string {
		return this.sessionDir;
	}

	/**
	 * 返回全部会话元数据，按 updatedAt 降序。
	 * @returns 会话元数据数组
	 */
	listSessions(): SessionMeta[] {
		return Object.values(this.index.sessions)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	/**
	 * 查询单个会话元数据。
	 * @param sessionId 会话 ID
	 * @returns 元数据或 undefined
	 */
	getSession(sessionId: string): SessionMeta | undefined {
		return this.index.sessions[sessionId];
	}

	/** 读取会话任务快照。 @param sessionId 会话 ID。 @returns 任务快照。 */
	getTodoSnapshot(sessionId: string): TodoSnapshot {
		return this.index.todos[sessionId] ?? { todos: [] };
	}

	/** 写入会话任务快照。 @param sessionId 会话 ID。 @param snapshot 任务快照。 @returns 无返回值。 */
	setTodoSnapshot(sessionId: string, snapshot: TodoSnapshot): void {
		this.mutateIndex((idx) => {
			idx.todos[sessionId] = snapshot;
		});
		logger.log(`[SessionFileStore] 写入任务快照 sessionId=${sessionId} count=${snapshot.todos.length}`);
	}

	/** 读取会话 Plan 状态；缺失或非法时回退 normal。 @param sessionId 会话 ID。 @returns Plan 状态。 */
	getPlanState(sessionId: string): SessionPlanState {
		return this.index.planStates[sessionId] ?? { stage: 'normal', draftCreated: false };
	}

	/** 写入会话 Plan 状态（原子持久化）。 @param sessionId 会话 ID。 @param state Plan 状态。 @returns 无返回值。 */
	setPlanState(sessionId: string, state: SessionPlanState): void {
		this.mutateIndex((idx) => {
			idx.planStates[sessionId] = state;
		});
		logger.log(`[SessionFileStore] 写入 Plan 状态 sessionId=${sessionId} stage=${state.stage} draftCreated=${state.draftCreated}`);
	}

	/**
	 * 创建会话：建立索引条目（空标题）并设为当前会话。不触碰既有会话数据。
	 * @param sessionId 会话 ID
	 */
	createSession(sessionId: string): void {
		const now = new Date().toISOString();
		this.mutateIndex((idx) => {
			if (!idx.sessions[sessionId]) {
				idx.sessions[sessionId] = {
					sessionId,
					title: '',
					createdAt: now,
					updatedAt: now,
					messageCount: 0,
					customTitle: false,
				};
			}
			idx.currentSessionId = sessionId;
		});
		logger.log(`[SessionFileStore] 创建会话 sessionId=${sessionId}`);
	}

	/**
	 * 设置当前活跃会话（用于历史会话恢复）。
	 * @param sessionId 会话 ID
	 */
	setCurrentSessionId(sessionId: string): void {
		this.mutateIndex((idx) => {
			idx.currentSessionId = sessionId;
		});
	}

	/**
	 * 追加一条消息到会话 JSONL（版本化归档，追加写），并联动更新索引标题/消息数/更新时间。
	 * 首次写入时原子写入 v2 session header 与首个 Entry（临时文件 + rename），
	 * 后续消息追加为具有递增 recordSeq 与父引用的新 Entry。
	 * 会话已被删除（索引无条目）时拒绝写入，避免重建幽灵文件。
	 * @param sessionId 会话 ID
	 * @param message 存储层消息
	 */
	appendMessage(sessionId: string, message: Message): void {
		if (!this.index.sessions[sessionId]) {
			logger.error(`[SessionFileStore] 会话不存在，忽略追加 sessionId=${sessionId}`);
			return;
		}
		this.enqueue(async () => {
			await fs.promises.mkdir(this.sessionDir, { recursive: true });
			const file = this.sessionFile(sessionId);
			const state = this.readTailState(file);
			if (state.format === 'legacy') {
				// 旧裸 Message JSONL：先迁移为 v2 归档，再追加新消息
				await this.migrateLegacyFile(file, sessionId);
				const after = this.readTailState(file);
				const entry = this.makeMessageEntry(message, after.nextRecordSeq, after.lastEntryId);
				await fs.promises.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
			} else if (state.format === 'empty') {
				// 首次写入：原子写出 header + 首个 Entry，避免半写文件
				const entries = [
					this.makeHeader(sessionId),
					this.makeMessageEntry(message, 1, null),
				];
				await this.atomicWrite(file, entries);
				logger.log(`[SessionFileStore] 首次写入归档 sessionId=${sessionId} recordSeq=1`);
			} else {
				const entry = this.makeMessageEntry(message, state.nextRecordSeq, state.lastEntryId);
				await fs.promises.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
				logger.log(`[SessionFileStore] 追加归档 sessionId=${sessionId} recordSeq=${entry.recordSeq} role=${message.role}`);
			}		}, { sessionId });
		const meta = this.index.sessions[sessionId];
		this.mutateIndex((idx) => {
			const m = idx.sessions[sessionId];
			if (!m) {
				return;
			}
			// 仅当无自定义标题且消息来自用户时，用首条用户消息生成默认标题
			if (!m.customTitle && !m.title && message.role === 'user') {
				idx.sessions[sessionId] = { ...m, title: deriveTitle(message.content) };
			}
			idx.sessions[sessionId] = {
				...idx.sessions[sessionId],
				updatedAt: new Date().toISOString(),
				messageCount: m.messageCount + 1,
			};
		});
	}

	/**
	 * 整体重写会话文件（deleteMessagesAfter / updateMessage / 删除后的破坏性路径）。
	 * 重写产物为合法 v2 归档：header + 线性 message Entry（recordSeq 连续、parentId 顺延）。
	 * @param sessionId 会话 ID
	 * @param messages 完整消息列表（按 seq 升序）
	 */
	rewriteSession(sessionId: string, messages: Message[]): void {
		this.enqueue(async () => {
			await fs.promises.mkdir(this.sessionDir, { recursive: true });
			const file = this.sessionFile(sessionId);
			const entries: SessionRecord[] = [this.makeHeader(sessionId)];
			for (let i = 0; i < messages.length; i++) {
				entries.push(this.makeMessageEntry(messages[i], i + 1, i === 0 ? null : (entries[i] as ArchiveEntry).id));
			}
			logger.log(`[SessionFileStore] 重写归档 sessionId=${sessionId} 消息数=${messages.length}`);
			await this.atomicWrite(file, entries);
		}, { sessionId });
		this.mutateIndex((idx) => {
			const m = idx.sessions[sessionId];
			if (m) {
				idx.sessions[sessionId] = {
					...m,
					updatedAt: new Date().toISOString(),
					messageCount: messages.length,
				};
			}
		});
	}

	/**
	 * 读取会话全部消息（活动路径投影）。
	 * 优先按 v2 归档解析；首行不是归档 header 时按旧裸 Message JSONL 双读回退（坏行跳过并告警）。
	 * 文件不存在返回空数组。
	 * @param sessionId 会话 ID
	 * @returns 消息数组
	 */
	readMessages(sessionId: string): Message[] {
		const file = this.sessionFile(sessionId);
		let raw: string;
		try {
			raw = fs.readFileSync(file, 'utf8');
		} catch {
			return [];
		}
		const trimmed = raw.trim();
		if (!trimmed) {
			return [];
		}
		// v2 归档：首条有效记录是 header 时按归档校验 + 活动路径投影
		const firstLine = trimmed.split('\n', 1)[0];
		const first = this.tryParseRecord(firstLine);
		if (first?.type === 'session') {
			const archive = loadArchive(file, sessionId);
			return projectActiveMessages(archive);
		}
		// 旧裸 Message JSONL：逐行解析，坏行跳过
		const messages: Message[] = [];
		for (const line of trimmed.split('\n')) {
			const record = this.tryParseRecord(line);
			if (record && 'role' in record) {
				messages.push(record as unknown as Message);
			} else if (line.trim()) {
				logger.error(`[SessionFileStore] 跳过坏行 sessionId=${sessionId} 行=${line.slice(0, 80)}`);
			}
		}
		return messages;
	}

	/**
	 * 删除会话：移除 JSONL 文件与索引条目。
	 * @param sessionId 会话 ID
	 */
	deleteSession(sessionId: string): void {
		this.enqueue(async () => {
			try {
				await fs.promises.unlink(this.sessionFile(sessionId));
			} catch {
				// 文件不存在视为已删除
			}
		});
		this.mutateIndex((idx) => {
			delete idx.sessions[sessionId];
			delete idx.todos[sessionId];
			delete idx.planStates[sessionId];
			if (idx.currentSessionId === sessionId) {
				idx.currentSessionId = undefined;
			}
		});
		logger.log(`[SessionFileStore] 删除会话 sessionId=${sessionId}`);
	}

	/**
	 * 设置会话标题（用户自定义，customTitle=true），并刷新更新时间（重命名后列表置顶）。
	 * @param sessionId 会话 ID
	 * @param title 自定义标题
	 */
	setCustomTitle(sessionId: string, title: string): void {
		this.mutateIndex((idx) => {
			const m = idx.sessions[sessionId];
			if (m) {
				idx.sessions[sessionId] = {
					...m,
					title,
					customTitle: true,
					updatedAt: new Date().toISOString(),
				};
			}
		});
	}

	/**
	 * 等待全部待落盘的写操作完成（含索引与记录写入）。
	 * 链路对每条操作单独捕获错误并记录日志，因此始终 resolve；
	 * 单次操作的失败可通过 commit() 或 enqueue 返回的 Promise 感知。
	 * @returns 落盘全部完成的 Promise
	 */
	flush(): Promise<void> {
		return this.writeChain;
	}

	/**
	 * 等待全部待提交写操作结算，并提供可拒绝的提交结果。
	 * 任一排队写入失败时该 Promise 拒绝（返回调用方而非仅记录日志），
	 * 拒绝原因包含定位信息（sessionId、失败原因），供 AgentLoop 与扩展停用流程判断并记录中文日志。
	 * @returns 提交结果（失败时拒绝）
	 */
	commit(): Promise<void> {
		const ops = this.pendingCommits.splice(0);
		return Promise.allSettled(ops.map((op) => op.promise)).then((results) => {
			const rejectedIndex = results.findIndex((result) => result.status === 'rejected');
			if (rejectedIndex >= 0) {
				const item = ops[rejectedIndex];
				const reason = (results[rejectedIndex] as PromiseRejectedResult).reason;
				const detail = reason instanceof Error ? reason.message : String(reason);
				const error = new Error(`会话归档提交失败 sessionId=${item.sessionId ?? '未知'} 原因=${detail}`);
				logger.error(`[SessionFileStore] 提交失败: ${error.message}`);
				throw error;
			}
		});
	}

	/**
	 * 将一条消息压入写串行链（保证每会话落盘顺序）。
	 * 返回可等待且可拒绝的提交句柄：操作失败时该 Promise 拒绝，
	 * 调用方（如 AgentLoop 的提交边界）可据此感知归档失败；
	 * 失败不会中断后续排队操作（链上单独捕获并记录日志）。
	 * @param op 写操作
	 * @returns 该操作完成的 Promise（失败时拒绝）
	 */
	private enqueue(op: () => Promise<void>, meta?: { sessionId?: string }): Promise<void> {
		const result = this.writeChain.then(op);
		const sessionId = meta?.sessionId;
		// 单条失败不弄断整条链：后续操作继续执行，但失败结果返回给本操作调用方
		this.writeChain = result.then(
			() => undefined,
			(err) => {
				logger.error(`[SessionFileStore] 落盘失败 sessionId=${sessionId ?? '未知'}:`, err instanceof Error ? err.message : String(err));
			},
		);
		this.pendingCommits.push({ promise: result, sessionId });
		return result;
	}

	/**
	 * 订阅索引变更（新建/追加/删除/重命名/切换当前会话）。
	 * @param listener 变更回调
	 * @returns 取消订阅函数
	 */
	onDidChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => {
			this.changeListeners.delete(listener);
		};
	}

	/**
	 * 同步修改内存索引并异步原子落盘（临时文件 + rename），随后通知变更监听器。
	 * @param mutator 索引变更函数
	 */
	private mutateIndex(mutator: (idx: MutableSessionIndex) => void): void {
		mutator(this.index);
		this.enqueue(async () => {
			const file = path.join(this.sessionDir, INDEX_FILE);
			await fs.promises.mkdir(this.sessionDir, { recursive: true });
			const tmp = `${file}.tmp`;
			await fs.promises.writeFile(tmp, JSON.stringify(this.index, null, 2), 'utf8');
			await fs.promises.rename(tmp, file);
		});
		for (const listener of this.changeListeners) {
			listener();
		}
	}

	/**
	 * 追加 head_update 记录持久化活动位置（回滚语义，不物理删除归档 Entry）。
	 * @param sessionId 会话 ID
	 * @param headEntryId 新活动 Entry ID；null 表示空活动路径
	 */
	appendHeadUpdate(sessionId: string, headEntryId: string | null): void {
		this.enqueue(async () => {
			await fs.promises.mkdir(this.sessionDir, { recursive: true });
			const file = this.sessionFile(sessionId);
			const state = this.readTailState(file);
			if (state.format !== 'v2') {
				// 空/旧格式会话：回滚前先建立 v2 归档（写入 header 即可，无消息时不追加虚拟消息）
				if (state.format === 'legacy') {
					await this.migrateLegacyFile(file, sessionId);
					return;
				}
				if (state.format === 'empty') {
					await this.atomicWrite(file, [this.makeHeader(sessionId)]);
				}
			}
			const update: ArchiveEntry = {
				type: 'entry',
				kind: 'head_update',
				id: randomUUID(),
				parentId: state.format === 'v2' ? state.lastEntryId : null,
				recordSeq: state.format === 'v2' ? state.nextRecordSeq : 1,
				timestamp: new Date().toISOString(),
				payload: { kind: 'head_update', headEntryId },
			};
			await fs.promises.appendFile(file, `${JSON.stringify(update)}\n`, 'utf8');
		}, { sessionId });
		logger.log(`[SessionFileStore] 追加活动位置更新 sessionId=${sessionId} headEntryId=${headEntryId ?? '空'}`);
	}

	/**
	 * 读取并校验会话归档（文件不存在返回空归档）。
	 * @param sessionId 会话 ID
	 * @returns 校验后的归档（含诊断与活动路径）
	 */
	readArchive(sessionId: string): ReturnType<typeof loadArchive> {
		return loadArchive(this.sessionFile(sessionId), sessionId);
	}

	/**
	 * 扫描当前工作区全部会话归档，提取每个已落账 assistant 调用的时间戳与 token 账快照。
	 * 追加式历史中每条 assistant 消息物理唯一，故每个已落账调用只返回一次；
	 * 回滚/删除活动路径不物理删除记录，仍会被扫描到。损坏或无法解析的会话归档被跳过，
	 * 其会话 ID 由调用方（用量统计）记录诊断并标记结果不完整。
	 * @returns 已落账记录列表、损坏会话 ID 列表与扫描的会话数
	 */
	scanTokenRecords(): { readonly records: ArchivedTokenRecord[]; readonly corruptSessions: string[]; readonly scannedCount: number } {
		let files: string[];
		try {
			files = fs.readdirSync(this.sessionDir).filter((name) => name.endsWith('.jsonl'));
		} catch {
			// 目录不存在：无历史会话，返回空结果
			return { records: [], corruptSessions: [], scannedCount: 0 };
		}
		const records: ArchivedTokenRecord[] = [];
		const corruptSessions: string[] = [];
		for (const file of files) {
			const sessionId = file.slice(0, -'.jsonl'.length);
			const archive = loadArchive(path.join(this.sessionDir, file), sessionId);
			if (archive.corrupt) {
				corruptSessions.push(sessionId);
				logger.error(`[SessionFileStore] 归档损坏被跳过 sessionId=${sessionId} 诊断数=${archive.diagnostics.length}（详见 SessionArchive 诊断日志）`);
				continue;
			}
			for (const entry of archive.entries) {
				if (entry.kind !== 'message' || entry.payload.kind !== 'message') {
					continue;
				}
				const message = entry.payload.message;
				if (message.role === 'assistant' && message.tokenUsage) {
					records.push({ sessionId, timestamp: entry.timestamp, tokenUsage: message.tokenUsage });
				}
			}
		}
		logger.log(`[SessionFileStore] 归档 token 扫描完成 会话数=${files.length} 记录数=${records.length} 损坏会话数=${corruptSessions.length}`);
		return { records, corruptSessions, scannedCount: files.length };
	}

	/**
	 * 查询会话活动位置缓存（Entry ID）。
	 * 仅作加速视图；活动位置的真实来源是归档内的 head_update 记录。
	 * @param sessionId 会话 ID
	 * @returns 活动 Entry ID 或 undefined
	 */
	getHeadEntryId(sessionId: string): string | undefined {
		return this.index.heads[sessionId];
	}

	/**
	 * 从磁盘加载索引；文件缺失/损坏时返回空索引（随后由 reconcileIndexFromArchives 重建）。
	 * @param workspacePath workspace 根路径
	 * @returns 索引
	 */
	private loadIndex(workspacePath: string): MutableSessionIndex {
		const empty: MutableSessionIndex = { version: 1, workspacePath, sessions: {}, todos: {}, planStates: {}, heads: {} };
		try {
			const raw = fs.readFileSync(path.join(this.sessionDir, INDEX_FILE), 'utf8');
			const parsed = JSON.parse(raw) as Partial<SessionIndex>;
			return {
				version: 1,
				workspacePath: typeof parsed.workspacePath === 'string' ? parsed.workspacePath : workspacePath,
				currentSessionId: typeof parsed.currentSessionId === 'string' ? parsed.currentSessionId : undefined,
				sessions: parsed.sessions && typeof parsed.sessions === 'object'
					? (parsed.sessions as Record<string, SessionMeta>)
					: {},
				todos: parseTodoSnapshots(parsed.todos),
				planStates: parsePlanStates(parsed.planStates),
				heads: parsed.heads && typeof parsed.heads === 'object'
					? (parsed.heads as Record<string, string>)
					: {},
			};
		} catch {
			return empty;
		}
	}

	/**
	 * 扫描会话目录中的合法归档，重建会话元数据与活动位置缓存：
	 * 补齐索引缺失的会话、修正消息计数、清除指向不存在文件的孤儿索引条目。
	 * 索引只是加速缓存，不得作为会话是否存在的唯一依据。
	 */
	private reconcileIndexFromArchives(): void {
		let files: string[];
		try {
			files = fs.readdirSync(this.sessionDir).filter((name) => name.endsWith('.jsonl'));
		} catch {
			// 目录不存在：无历史会话，无需重建
			return;
		}
		const seen = new Set<string>();
		for (const file of files) {
			const sessionId = file.slice(0, -'.jsonl'.length);
			seen.add(sessionId);
			const archive = loadArchive(path.join(this.sessionDir, file), sessionId);
			if (!archive.header) {
				// 无合法 header：不视为会话（旧裸格式由单会话迁移/读取路径处理）
				continue;
			}
			const messageCount = archive.entries.filter((entry) => entry.kind === 'message').length;
			const updatedAt = archive.entries.length > 0
				? archive.entries[archive.entries.length - 1].timestamp
				: archive.header.createdAt;
			const existing = this.index.sessions[sessionId];
			if (existing) {
				// 已有条目：修正计数与活动位置缓存，保留自定义标题与既有元数据
				this.index.sessions[sessionId] = { ...existing, messageCount, updatedAt };
			} else {
				const title = this.deriveTitleFromArchive(archive);
				this.index.sessions[sessionId] = {
					sessionId,
					title,
					createdAt: archive.header.createdAt,
					updatedAt,
					messageCount,
					customTitle: false,
				};
				logger.log(`[SessionFileStore] 从归档重建索引条目 sessionId=${sessionId} messageCount=${messageCount}`);
			}
			if (archive.headEntryId) {
				this.index.heads[sessionId] = archive.headEntryId;
			}
		}
		// 清除孤儿索引条目：有消息记录但会话文件已不存在。
		// 空会话（无文件、messageCount=0）的索引条目是 Todo/Plan 等 sidecar 的载体，予以保留。
		for (const sessionId of Object.keys(this.index.sessions)) {
			if (!seen.has(sessionId) && (this.index.sessions[sessionId]?.messageCount ?? 0) > 0) {
				delete this.index.sessions[sessionId];
				delete this.index.todos[sessionId];
				delete this.index.planStates[sessionId];
				delete this.index.heads[sessionId];
				if (this.index.currentSessionId === sessionId) {
					this.index.currentSessionId = undefined;
				}
			}
		}
	}

	/**
	 * 从归档中提取默认标题：首条用户消息内容截断；无用户消息时为空串。
	 * @param archive 校验后的归档。
	 * @returns 标题文本。
	 */
	private deriveTitleFromArchive(archive: ReturnType<typeof loadArchive>): string {
		for (const entry of archive.entries) {
			if (entry.kind === 'message' && entry.payload.kind === 'message' && entry.payload.message.role === 'user') {
				return deriveTitle(entry.payload.message.content);
			}
		}
		return '';
	}

	/**
	 * 会话 JSONL 文件路径。
	 * @param sessionId 会话 ID
	 * @returns 绝对路径
	 */
	private sessionFile(sessionId: string): string {
		return path.join(this.sessionDir, `${sessionId}.jsonl`);
	}

	/** 构建 v2 session header 记录。 @param sessionId 会话 ID。 @returns header 记录。 */
	private makeHeader(sessionId: string): SessionHeader {
		return {
			type: 'session',
			version: SESSION_ARCHIVE_VERSION,
			sessionId,
			createdAt: new Date().toISOString(),
			workspacePath: this.workspacePath,
		};
	}

	/**
	 * 构建消息 Entry 记录。
	 * @param message 存储层消息。
	 * @param recordSeq 物理序号。
	 * @param parentId 父 Entry ID（首条为 null）。
	 * @returns ArchiveEntry。
	 */
	private makeMessageEntry(message: Message, recordSeq: number, parentId: string | null): ArchiveEntry {
		return {
			type: 'entry',
			kind: 'message',
			id: randomUUID(),
			parentId,
			recordSeq,
			timestamp: new Date().toISOString(),
			payload: { kind: 'message', message },
		};
	}

	/**
	 * 将旧裸 Message JSONL 惰性迁移为版本化 v2 归档：
	 * 按原物理顺序映射为线性父子 Entry + header；先在临时文件写入并做完整结构校验，
	 * 通过后备份原文件为 <file>.bak，再原子替换；失败时保留原文件、删除临时产物并抛错（只读回退）。
	 * @param file 会话文件路径。
	 * @param sessionId 会话 ID。
	 * @throws 迁移产物未通过结构校验或写入失败时抛出。
	 */
	private async migrateLegacyFile(file: string, sessionId: string): Promise<void> {
		const raw = await fs.promises.readFile(file, 'utf8');
		const messages: Message[] = [];
		for (const line of raw.split('\n')) {
			const record = this.tryParseRecord(line);
			if (record && 'role' in record) {
				messages.push(record as unknown as Message);
			} else if (line.trim()) {
				logger.error(`[SessionFileStore] 迁移跳过坏行 sessionId=${sessionId} 行=${line.slice(0, 80)}`);
			}
		}
		const records: SessionRecord[] = [this.makeHeader(sessionId)];
		let parentId: string | null = null;
		for (let i = 0; i < messages.length; i++) {
			const entry = this.makeMessageEntry(messages[i], i + 1, parentId);
			records.push(entry);
			parentId = entry.id;
		}
		// 完整结构校验：header、ID 唯一性、父引用、记录顺序；失败则保留原文件
		const validated = validateArchive(records, sessionId);
		if (validated.corrupt) {
			throw new Error(`会话迁移校验失败 sessionId=${sessionId} 原文件保留，不覆盖`);
		}
		// 原文件备份 + 原子替换
		const backup = `${file}.bak`;
		const tmp = `${file}.migrate.tmp`;
		const body = records.map((record) => JSON.stringify(record)).join('\n');
		await fs.promises.writeFile(tmp, `${body}\n`, 'utf8');
		await fs.promises.copyFile(file, backup);
		await fs.promises.rename(tmp, file);
		logger.log(`[SessionFileStore] 旧格式迁移完成 sessionId=${sessionId} 消息数=${messages.length} 备份=${backup}`);
	}

	/**
	 * 读取文件尾部状态：格式类别、最后一条 Entry 的 ID 与下一个 recordSeq。
	 * 文件不存在或为空为 empty；首行非 header 为 legacy（旧裸 Message JSONL）；
	 * 首行为合法 header 为 v2。
	 * @param file 会话文件路径。
	 * @returns 尾部状态。
	 */
	private readTailState(file: string): { format: 'empty' | 'legacy' | 'v2'; lastEntryId: string | null; nextRecordSeq: number } {
		try {
			const raw = fs.readFileSync(file, 'utf8');
			const lines = raw.split('\n').filter((line) => line.trim());
			if (lines.length === 0) {
				return { format: 'empty', lastEntryId: null, nextRecordSeq: 1 };
			}
			const first = this.tryParseRecord(lines[0]);
			if (first?.type !== 'session') {
				// 旧裸 Message JSONL：后续 append 前先迁移
				return { format: 'legacy', lastEntryId: null, nextRecordSeq: lines.length + 1 };
			}
			let lastId: string | null = null;
			let lastSeq = 0;
			for (const line of lines.slice(1)) {
				const record = this.tryParseRecord(line);
				if (record?.type === 'entry' && record.recordSeq > lastSeq) {
					lastSeq = record.recordSeq;
					lastId = record.id;
				}
			}
			return { format: 'v2', lastEntryId: lastId, nextRecordSeq: lastSeq + 1 };
		} catch {
			return { format: 'empty', lastEntryId: null, nextRecordSeq: 1 };
		}
	}

	/**
	 * 尝试解析 JSONL 单行记录；失败返回 undefined。
	 * @param line 单行文本。
	 * @returns 解析结果或 undefined。
	 */
	private tryParseRecord(line: string): SessionRecord | undefined {
		try {
			return JSON.parse(line) as SessionRecord;
		} catch {
			return undefined;
		}
	}

	/**
	 * 将记录数组原子写入文件（临时文件 + rename），避免半写文件。
	 * @param file 目标文件路径。
	 * @param records 记录数组。
	 */
	private async atomicWrite(file: string, records: SessionRecord[]): Promise<void> {
		const tmp = `${file}.tmp`;
		const body = records.map((record) => JSON.stringify(record)).join('\n');
		await fs.promises.writeFile(tmp, body ? `${body}\n` : '', 'utf8');
		await fs.promises.rename(tmp, file);
	}
}
