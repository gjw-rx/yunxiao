/**
 * 会话文件存储 - 将会话消息持久化到 ~/.yunForce/projects/<workspace 编码>/ 目录。
 * 参照 Claude Code 存储范式：每个会话一个 JSONL 文件（一行一条消息，追加写），
 * index.json 维护会话索引（标题/时间/消息数），支持原子替换与坏行容忍。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Message } from './types';
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

/** 会话索引文件结构 */
export interface SessionIndex {
	readonly version: 1;
	/** 所属 workspace 根路径（原始） */
	readonly workspacePath: string;
	/** 当前活跃会话 ID */
	readonly currentSessionId?: string;
	/** sessionId -> 元数据 */
	readonly sessions: Record<string, SessionMeta>;
}

/** 内部可变索引（SessionIndex 的写版本，供 mutateIndex 修改） */
type MutableSessionIndex = {
	version: 1;
	workspacePath: string;
	currentSessionId?: string;
	sessions: Record<string, SessionMeta>;
};

/** 默认标题长度上限（字符） */
export const TITLE_MAX = 40;

/** index.json 文件名 */
const INDEX_FILE = 'index.json';

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
	/** 索引内存缓存（可变写版本） */
	private index: MutableSessionIndex;
	/** 写操作串行链，保证落盘顺序 */
	private writeChain: Promise<void> = Promise.resolve();
	/** 索引变更监听器（新建/追加/删除/重命名/切换时触发） */
	private readonly changeListeners = new Set<() => void>();

	/**
	 * @param workspacePath workspace 根路径（用于目录编码与索引记录）
	 * @param baseDir 存储根目录，默认 ~/.yunForce/projects（测试可注入临时目录）
	 */
	constructor(workspacePath: string, baseDir?: string) {
		const root = baseDir ?? path.join(os.homedir(), '.yunForce', 'projects');
		this.sessionDir = path.join(root, encodeWorkspacePath(workspacePath));
		this.index = this.loadIndex(workspacePath);
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
	 * 追加一条消息到会话 JSONL（追加写），并联动更新索引标题/消息数/更新时间。
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
			await fs.promises.appendFile(file, `${JSON.stringify(message)}\n`, 'utf8');
		});
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
	 * 整体重写会话文件（deleteMessagesAfter / updateMessage 后的低频路径）。
	 * @param sessionId 会话 ID
	 * @param messages 完整消息列表（按 seq 升序）
	 */
	rewriteSession(sessionId: string, messages: Message[]): void {
		this.enqueue(async () => {
			await fs.promises.mkdir(this.sessionDir, { recursive: true });
			const file = this.sessionFile(sessionId);
			const lines = messages.map((m) => JSON.stringify(m)).join('\n');
			await fs.promises.writeFile(file, lines ? `${lines}\n` : '', 'utf8');
		});
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
	 * 读取会话全部消息（坏行跳过并告警）。文件不存在返回空数组。
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
		const messages: Message[] = [];
		for (const line of raw.split('\n')) {
			if (!line.trim()) {
				continue;
			}
			try {
				messages.push(JSON.parse(line) as Message);
			} catch {
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
	 * 等待全部待落盘的写操作完成（测试用）。
	 * @returns 落盘完成的 Promise
	 */
	flush(): Promise<void> {
		return this.writeChain;
	}

	/**
	 * 将一条消息压入写串行链（保证落盘顺序）。
	 * @param op 写操作
	 */
	private enqueue(op: () => Promise<void>): void {
		this.writeChain = this.writeChain.then(op).catch((err) => {
			logger.error('[SessionFileStore] 落盘失败:', err instanceof Error ? err.message : String(err));
		});
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
	 * 从磁盘加载索引；文件缺失/损坏时返回空索引。
	 * @param workspacePath workspace 根路径
	 * @returns 索引
	 */
	private loadIndex(workspacePath: string): MutableSessionIndex {
		const empty: SessionIndex = { version: 1, workspacePath, sessions: {} };
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
			};
		} catch {
			return empty;
		}
	}

	/**
	 * 会话 JSONL 文件路径。
	 * @param sessionId 会话 ID
	 * @returns 绝对路径
	 */
	private sessionFile(sessionId: string): string {
		return path.join(this.sessionDir, `${sessionId}.jsonl`);
	}
}
