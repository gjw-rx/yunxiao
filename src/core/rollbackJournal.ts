/**
 * 回滚快照日志 - 持久化写文件工具改动前的状态，供用户输入 turn 回滚时恢复文件。
 *
 * 存储布局（位于 SessionFileStore 的 workspace 隔离目录下）：
 *   ~/.yunForce/projects/<ws 编码>/rollback/<sessionId>/<userSeq>/
 *     files/<相对路径>   改动前文件/目录副本（目标原本不存在时无副本）
 *     manifest.jsonl     变更条目（一行一条 JSON，追加写）
 * 同一 turn 内对同一文件多次改动只保留首次记录（即 turn 开始前的状态）。
 * 快照记录失败不阻断工具执行，仅输出日志。
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as logger from '../logger';

/** 单条回滚快照条目。 */
export interface RollbackEntry {
	/** 所属用户输入消息的 seq（turn 边界） */
	readonly userSeq: number;
	/** 相对工作区根的文件路径 */
	readonly relativePath: string;
	/** 改动前目标是否存在（false=turn 内新建，回滚时应删除） */
	readonly existedBefore: boolean;
	/** 快照副本相对 turn 目录 files/ 的路径（existedBefore 时存在） */
	readonly snapshotPath?: string;
}

/** 回滚快照记录参数。 */
export interface RollbackRecordOptions {
	/** 会话 ID */
	readonly sessionId: string;
	/** 用户输入消息 seq（turn 边界） */
	readonly userSeq: number;
	/** 目标文件绝对路径 */
	readonly fsPath: string;
	/** 相对工作区根的文件路径 */
	readonly relativePath: string;
	/** 改动前目标是否存在 */
	readonly existedBefore: boolean;
}

/** 写文件工具注入的轻量回滚记录接口（便于解耦与测试注入）。 */
export interface RollbackRecorder {
	/**
	 * 记录一次文件改动前的快照。
	 * @param opts 记录参数
	 * @returns 完成 Promise
	 */
	record(opts: RollbackRecordOptions): Promise<void>;
}

/** 回滚快照日志：持久化 before 副本并支持按 turn 恢复/清理。 */
export class RollbackJournal implements RollbackRecorder {
	/**
	 * @param baseDir 回滚快照根目录（~/.yunForce/projects/<ws 编码>/rollback）
	 */
	constructor(private readonly baseDir: string) {}

	/**
	 * 记录改动前快照：目标存在时复制其内容到快照目录（同 turn 重复改动仅保留首次），并追加 manifest 条目。
	 * @param opts 记录参数
	 * @returns 完成 Promise
	 */
	async record(opts: RollbackRecordOptions): Promise<void> {
		const { sessionId, userSeq, fsPath, relativePath, existedBefore } = opts;
		try {
			const turnDir = this.turnDir(sessionId, userSeq);
			const filesDir = path.join(turnDir, 'files');
			await fs.mkdir(filesDir, { recursive: true });
			let snapshotPath: string | undefined;
			if (existedBefore) {
				snapshotPath = relativePath;
				const dest = path.join(filesDir, relativePath);
				if (!(await this.exists(dest))) {
					await fs.mkdir(path.dirname(dest), { recursive: true });
					await fs.cp(fsPath, dest, { recursive: true });
				}
			}
			const entry: RollbackEntry = {
				userSeq,
				relativePath,
				existedBefore,
				...(snapshotPath ? { snapshotPath } : {}),
			};
			await fs.appendFile(this.manifestFile(sessionId, userSeq), `${JSON.stringify(entry)}\n`, 'utf8');
			logger.log(`[RollbackJournal] 记录快照 sessionId=${sessionId} userSeq=${userSeq} path=${relativePath} existedBefore=${existedBefore}`);
		} catch (err) {
			// 快照失败不阻断工具执行，仅记录日志
			logger.error(`[RollbackJournal] 记录快照失败 sessionId=${sessionId} userSeq=${userSeq} path=${relativePath} error=${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * 恢复 userSeq 及之后所有 turn 的文件改动到 userSeq 开始前，并清理对应快照目录。
	 * 同一文件在多个 turn 被改动时，取 userSeq 最小（最接近回滚点）的 before 状态恢复。
	 *
	 * @param sessionId 会话 ID
	 * @param userSeq turn 边界 seq（回滚该用户消息）
	 * @param workspaceRoot 工作区根路径
	 * @returns 恢复的文件数
	 */
	async restoreTurn(sessionId: string, userSeq: number, workspaceRoot: string): Promise<number> {
		const sessionDir = this.sessionDir(sessionId);
		const turnDirs = await this.listTurnDirs(sessionDir);
		const targets = turnDirs.filter((seq) => seq >= userSeq);
		if (targets.length === 0) {
			logger.log(`[RollbackJournal] 无可恢复快照 sessionId=${sessionId} userSeq=${userSeq}`);
			return 0;
		}
		const entries: RollbackEntry[] = [];
		for (const seq of targets) {
			entries.push(...(await this.readManifest(sessionId, seq)));
		}
		const byPath = new Map<string, RollbackEntry>();
		for (const e of entries) {
			const prev = byPath.get(e.relativePath);
			if (!prev || e.userSeq < prev.userSeq) {
				byPath.set(e.relativePath, e);
			}
		}
		const root = path.resolve(workspaceRoot);
		let restored = 0;
		for (const [rel, entry] of byPath) {
			const target = path.resolve(root, rel);
			// 路径守卫：拒绝逃逸工作区根的快照路径
			if (target !== root && !target.startsWith(root + path.sep)) {
				logger.error(`[RollbackJournal] 跳过越界路径 rel=${rel}`);
				continue;
			}
			try {
				if (entry.existedBefore && entry.snapshotPath) {
					const src = path.join(this.turnDir(sessionId, entry.userSeq), 'files', entry.snapshotPath);
					await fs.rm(target, { recursive: true, force: true });
					await fs.cp(src, target, { recursive: true });
				} else {
					// turn 内新建：直接删除
					await fs.rm(target, { recursive: true, force: true });
				}
				restored++;
			} catch (err) {
				logger.error(`[RollbackJournal] 恢复文件失败 sessionId=${sessionId} path=${rel} error=${err instanceof Error ? err.message : String(err)}`);
			}
		}
		await this.clearAfterSeq(sessionId, userSeq);
		logger.log(`[RollbackJournal] 恢复完成 sessionId=${sessionId} userSeq=${userSeq} 恢复文件数=${restored}`);
		return restored;
	}

	/**
	 * 清理 userSeq 及之后的回滚快照目录（消息截断/回滚后调用）。
	 * @param sessionId 会话 ID
	 * @param userSeq turn 边界 seq
	 * @returns 完成 Promise
	 */
	async clearAfterSeq(sessionId: string, userSeq: number): Promise<void> {
		const sessionDir = this.sessionDir(sessionId);
		const turnDirs = await this.listTurnDirs(sessionDir);
		for (const seq of turnDirs) {
			if (seq >= userSeq) {
				await fs.rm(path.join(sessionDir, String(seq)), { recursive: true, force: true }).catch(() => { });
			}
		}
		logger.log(`[RollbackJournal] 清理快照 sessionId=${sessionId} userSeq>=${userSeq}`);
	}

	/**
	 * 清理会话全部回滚快照（删除会话时调用）。
	 * @param sessionId 会话 ID
	 * @returns 完成 Promise
	 */
	async clearSession(sessionId: string): Promise<void> {
		await fs.rm(this.sessionDir(sessionId), { recursive: true, force: true }).catch(() => { });
		logger.log(`[RollbackJournal] 清理会话快照 sessionId=${sessionId}`);
	}

	/** 会话快照根目录。 @param sessionId 会话 ID。 @returns 目录绝对路径。 */
	private sessionDir(sessionId: string): string {
		return path.join(this.baseDir, sessionId);
	}

	/** 某 turn 的快照目录。 @param sessionId 会话 ID。 @param userSeq turn 边界 seq。 @returns 目录绝对路径。 */
	private turnDir(sessionId: string, userSeq: number): string {
		return path.join(this.sessionDir(sessionId), String(userSeq));
	}

	/** 某 turn 的 manifest 文件路径。 @param sessionId 会话 ID。 @param userSeq turn 边界 seq。 @returns 文件绝对路径。 */
	private manifestFile(sessionId: string, userSeq: number): string {
		return path.join(this.turnDir(sessionId, userSeq), 'manifest.jsonl');
	}

	/**
	 * 列出会话快照目录下的 turn 序号（数字目录名，升序）。
	 * @param sessionDir 会话快照根目录
	 * @returns turn 序号数组
	 */
	private async listTurnDirs(sessionDir: string): Promise<number[]> {
		let entries;
		try {
			entries = await fs.readdir(sessionDir, { withFileTypes: true });
		} catch {
			return [];
		}
		const seqs: number[] = [];
		for (const e of entries) {
			if (e.isDirectory() && /^\d+$/.test(e.name)) {
				seqs.push(Number(e.name));
			}
		}
		return seqs.sort((a, b) => a - b);
	}

	/**
	 * 读取某 turn 的全部变更条目（坏行跳过并告警）。
	 * @param sessionId 会话 ID
	 * @param userSeq turn 边界 seq
	 * @returns 变更条目数组
	 */
	private async readManifest(sessionId: string, userSeq: number): Promise<RollbackEntry[]> {
		const file = this.manifestFile(sessionId, userSeq);
		let raw: string;
		try {
			raw = await fs.readFile(file, 'utf8');
		} catch {
			return [];
		}
		const entries: RollbackEntry[] = [];
		for (const line of raw.split('\n')) {
			if (!line.trim()) {
				continue;
			}
			try {
				entries.push(JSON.parse(line) as RollbackEntry);
			} catch {
				logger.error(`[RollbackJournal] 跳过坏行 sessionId=${sessionId} userSeq=${userSeq}`);
			}
		}
		return entries;
	}

	/**
	 * 判断路径是否存在。
	 * @param p 路径
	 * @returns 是否存在
	 */
	private async exists(p: string): Promise<boolean> {
		try {
			await fs.stat(p);
			return true;
		} catch {
			return false;
		}
	}
}
