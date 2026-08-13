/**
 * 会话代码变更日志 - 保存受插件管理的写工具在单个用户回合中的首个修改前状态与最终状态，供独立变更页展示。
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { diffLines } from 'diff';
import simpleGit from 'simple-git';
import * as logger from '../logger';

/** 会话累计变更集的固定标识。 */
const SESSION_CHANGE_SET_ID = 'session';
/** 非 Git 工作区兜底扫描时不纳入会话快照的目录。 */
const EXCLUDED_WORKSPACE_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'out', '.vscode-test', '.venv', 'venv', 'coverage', '.cache', '.npm-cache']);
/** 单个可审查文本文件的最大字节数。 */
const MAX_SNAPSHOT_FILE_BYTES = 1_000_000;

/** 变更文件状态。 */
export type ChangeFileStatus = 'added' | 'modified' | 'deleted';

/** 变更记录器写入前后的文件定位参数。 */
export interface ChangeRecordOptions {
	/** 会话 ID。 */
	readonly sessionId: string;
	/** 本次用户输入的消息序号。 */
	readonly userSeq: number;
	/** 文件绝对路径。 */
	readonly fsPath: string;
	/** 相对工作区根路径。 */
	readonly relativePath: string;
}

/** 写工具使用的会话变更记录接口。 */
export interface ChangeRecorder {
	/** 在文件修改前记录首个内容快照。 */
	recordBefore(options: ChangeRecordOptions): Promise<void>;
	/** 在文件成功修改后更新最终内容快照。 */
	recordAfter(options: ChangeRecordOptions): Promise<void>;
}

/** 变更集中文件的概览数据。 */
export interface ChangeFileSummary {
	/** 文件在变更集内的稳定标识。 */
	readonly id: string;
	/** 相对工作区根路径。 */
	readonly relativePath: string;
	/** 新增、修改或删除状态。 */
	readonly status: ChangeFileStatus;
	/** 新增行数。 */
	readonly additions: number;
	/** 删除行数。 */
	readonly deletions: number;
}

/** 已完成变更集的概览数据。 */
export interface ChangeSetSummary {
	/** 变更集 ID，在同一会话中唯一。 */
	readonly id: string;
	/** 来源用户消息序号。 */
	readonly userSeq: number;
	/** 文件变更列表。 */
	readonly files: readonly ChangeFileSummary[];
	/** 文件数量。 */
	readonly fileCount: number;
	/** 累计新增行数。 */
	readonly additions: number;
	/** 累计删除行数。 */
	readonly deletions: number;
}

/** 单个文件的完整变更详情。 */
export interface ChangeFileDetail extends ChangeFileSummary {
	/** 修改前文本；新建文件为空字符串。 */
	readonly before: string;
	/** 修改后文本；删除文件为空字符串。 */
	readonly after: string;
}

/** 持久化的文件条目。 */
interface PersistedFile extends ChangeFileSummary {
	/** 修改前快照文件名。 */
	readonly beforeFile: string;
	/** 修改后快照文件名。 */
	readonly afterFile: string;
}

/** 持久化的变更集清单。 */
interface PersistedChangeSet extends Omit<ChangeSetSummary, 'files'> {
	/** 文件条目。 */
	readonly files: readonly PersistedFile[];
}

/** 正在聚合的文件变更。 */
interface PendingFile {
	/** 文件绝对路径。 */
	readonly fsPath: string;
	/** 相对工作区根路径。 */
	readonly relativePath: string;
	/** 首次修改前内容，null 表示不存在。 */
	readonly before: string | null;
	/** 最近一次成功修改后的内容，undefined 表示尚未成功落盘。 */
	after?: string | null;
}

/** 会话基线中某个文件的持久化定位信息。 */
interface BaselineFile {
	/** 相对工作区根路径。 */
	readonly relativePath: string;
	/** 快照文件名。 */
	readonly contentFile: string;
}

/** 持久化的会话工作区基线。 */
interface SessionBaseline {
	/** 基线文件清单。 */
	readonly files: readonly BaselineFile[];
}

/** 会话代码变更日志。 */
export class ChangeJournal implements ChangeRecorder {
	/** 正在执行中的回合变更缓存。 */
	private readonly pending = new Map<string, Map<string, PendingFile>>();
	/** 正在创建的会话基线任务，避免同一会话重复扫描工作区。 */
	private readonly baselineTasks = new Map<string, Promise<void>>();

	/**
	 * @param baseDir 工作区隔离的变更日志根目录。
	 */
	constructor(private readonly baseDir: string) {}

	/**
	 * 在会话首次运行前持久化可审查工作区文件的基线快照；已有基线时不覆盖。
	 * @param sessionId 会话 ID。
	 * @param workspaceRoot 工作区根目录。
	 * @returns 完成 Promise。
	 */
	async ensureSessionBaseline(sessionId: string, workspaceRoot: string): Promise<void> {
		const existingTask = this.baselineTasks.get(sessionId);
		if (existingTask) {
			return existingTask;
		}
		if (await this.readBaseline(sessionId)) {
			return;
		}
		const concurrentTask = this.baselineTasks.get(sessionId);
		if (concurrentTask) {
			return concurrentTask;
		}
		const task = this.createSessionBaseline(sessionId, workspaceRoot);
		this.baselineTasks.set(sessionId, task);
		try {
			await task;
		} finally {
			this.baselineTasks.delete(sessionId);
		}
	}

	/**
	 * 创建并持久化一次会话工作区基线。
	 * @param sessionId 会话 ID。
	 * @param workspaceRoot 工作区根目录。
	 * @returns 完成 Promise。
	 */
	private async createSessionBaseline(sessionId: string, workspaceRoot: string): Promise<void> {
		logger.log(`[ChangeJournal] 开始创建会话工作区基线 sessionId=${sessionId}`);
		const files = await this.scanWorkspace(workspaceRoot);
		const baselineDir = this.baselineDir(sessionId);
		await fs.mkdir(path.join(baselineDir, 'files'), { recursive: true });
		const fileEntries = [...files.entries()];
		const manifestFiles: BaselineFile[] = [];
		for (let start = 0; start < fileEntries.length; start += 32) {
			const batch = await Promise.all(fileEntries.slice(start, start + 32).map(async ([relativePath, content], offset) => {
				const index = start + offset;
				const contentFile = `files/${index}.snapshot`;
				await fs.writeFile(path.join(baselineDir, contentFile), content, 'utf8');
				return { relativePath, contentFile };
			}));
			manifestFiles.push(...batch);
		}
		await fs.writeFile(path.join(baselineDir, 'manifest.json'), JSON.stringify({ files: manifestFiles }, null, 2), 'utf8');
		logger.log(`[ChangeJournal] 创建会话工作区基线 sessionId=${sessionId} files=${manifestFiles.length}`);
	}

	/**
	 * 将当前工作区与会话基线比较，并覆盖写入该会话的累计变更集。
	 * @param sessionId 会话 ID。
	 * @param workspaceRoot 工作区根目录。
	 * @param userSeq 触发本次刷新的用户消息序号。
	 * @returns 当前会话累计变更集概览或 undefined。
	 */
	async refreshSession(sessionId: string, workspaceRoot: string, userSeq: number): Promise<ChangeSetSummary | undefined> {
		await this.ensureSessionBaseline(sessionId, workspaceRoot);
		const baseline = await this.readBaseline(sessionId);
		if (!baseline) {
			logger.error(`[ChangeJournal] 会话基线不可用 sessionId=${sessionId}`);
			return undefined;
		}
		const beforeFiles = new Map<string, string>();
		for (const file of baseline.files) {
			const content = await this.readText(path.join(this.baselineDir(sessionId), file.contentFile));
			if (content !== null) {
				beforeFiles.set(file.relativePath, content);
			}
		}
		const afterFiles = await this.scanWorkspace(workspaceRoot);
		const paths = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
		const entries = [...paths]
			.sort((left, right) => left.localeCompare(right))
			.map((relativePath) => ({
				relativePath,
				before: beforeFiles.get(relativePath) ?? null,
				after: afterFiles.get(relativePath) ?? null,
			}))
			.filter((entry) => entry.before !== entry.after);
		this.pending.delete(this.turnKey(sessionId, userSeq));
		if (entries.length === 0) {
			await fs.rm(this.changeSetDir(sessionId, SESSION_CHANGE_SET_ID), { recursive: true, force: true });
			logger.log(`[ChangeJournal] 会话无累计变更 sessionId=${sessionId}`);
			return undefined;
		}
		const summary = await this.persistChangeSet(sessionId, SESSION_CHANGE_SET_ID, userSeq, entries);
		logger.log(`[ChangeJournal] 刷新会话累计变更 sessionId=${sessionId} files=${summary.fileCount}`);
		return toSummary(summary);
	}

	/**
	 * 记录文件首次修改前的内容；同一回合同一路径后续调用保持首次快照。
	 * @param options 受影响文件定位信息。
	 * @returns 完成 Promise。
	 */
	async recordBefore(options: ChangeRecordOptions): Promise<void> {
		const files = this.pendingFiles(options.sessionId, options.userSeq);
		if (files.has(options.relativePath)) {
			return;
		}
		const before = await this.readText(options.fsPath);
		files.set(options.relativePath, {
			fsPath: options.fsPath,
			relativePath: options.relativePath,
			before,
		});
		logger.log(`[ChangeJournal] 记录修改前快照 sessionId=${options.sessionId} userSeq=${options.userSeq} path=${options.relativePath}`);
	}

	/**
	 * 记录文件成功修改后的最终内容；未先记录的路径会忽略，避免把已修改状态误作初始状态。
	 * @param options 受影响文件定位信息。
	 * @returns 完成 Promise。
	 */
	async recordAfter(options: ChangeRecordOptions): Promise<void> {
		const file = this.pendingFiles(options.sessionId, options.userSeq).get(options.relativePath);
		if (!file) {
			logger.error(`[ChangeJournal] 缺少修改前快照，忽略修改后记录 sessionId=${options.sessionId} path=${options.relativePath}`);
			return;
		}
		file.after = await this.readText(options.fsPath);
		logger.log(`[ChangeJournal] 记录修改后快照 sessionId=${options.sessionId} userSeq=${options.userSeq} path=${options.relativePath}`);
	}

	/**
	 * 完成本轮变更集并持久化可回放快照；无实际成功变更时返回 undefined。
	 * @param sessionId 会话 ID。
	 * @param userSeq 来源用户消息序号。
	 * @returns 持久化后的变更集概览或 undefined。
	 */
	async finalize(sessionId: string, userSeq: number): Promise<ChangeSetSummary | undefined> {
		const key = this.turnKey(sessionId, userSeq);
		const pending = this.pending.get(key);
		this.pending.delete(key);
		if (!pending) {
			return undefined;
		}
		const entries = [...pending.values()]
			.filter((entry) => entry.after !== undefined && entry.before !== entry.after)
			.map((entry) => ({ ...entry, after: entry.after! }));
		if (entries.length === 0) {
			return undefined;
		}

		const summary = await this.persistChangeSet(sessionId, String(userSeq), userSeq, entries);
		logger.log(`[ChangeJournal] 完成变更集 sessionId=${sessionId} userSeq=${userSeq} files=${summary.fileCount}`);
		return toSummary(summary);
	}

	/**
	 * 读取指定会话的持久化变更集概览。
	 * @param sessionId 会话 ID。
	 * @param changeSetId 变更集 ID。
	 * @returns 概览或 undefined。
	 */
	async getSummary(sessionId: string, changeSetId: string): Promise<ChangeSetSummary | undefined> {
		const manifest = await this.readManifest(sessionId, changeSetId);
		return manifest ? toSummary(manifest) : undefined;
	}

	/**
	 * 读取变更集内某文件的前后快照。
	 * @param sessionId 会话 ID。
	 * @param changeSetId 变更集 ID。
	 * @param fileId 文件稳定标识。
	 * @returns 文件详情或 undefined。
	 */
	async getFileDetail(sessionId: string, changeSetId: string, fileId: string): Promise<ChangeFileDetail | undefined> {
		const manifest = await this.readManifest(sessionId, changeSetId);
		const file = manifest?.files.find((item) => item.id === fileId);
		if (!manifest || !file) {
			return undefined;
		}
		const setDir = this.changeSetDir(sessionId, changeSetId);
		const [before, after] = await Promise.all([
			this.readText(path.join(setDir, file.beforeFile)),
			this.readText(path.join(setDir, file.afterFile)),
		]);
		return { ...file, before: before ?? '', after: after ?? '' };
	}

	/**
	 * 清除会话的全部变更集与内存缓存。
	 * @param sessionId 会话 ID。
	 * @returns 完成 Promise。
	 */
	async clearSession(sessionId: string): Promise<void> {
		this.baselineTasks.delete(sessionId);
		for (const key of this.pending.keys()) {
			if (key.startsWith(`${sessionId}:`)) {
				this.pending.delete(key);
			}
		}
		await fs.rm(path.join(this.baseDir, sessionId), { recursive: true, force: true }).catch(() => {});
		logger.log(`[ChangeJournal] 清理会话变更 sessionId=${sessionId}`);
	}

	/**
	 * 清除指定序号及之后回合的变更集与内存缓存。
	 * @param sessionId 会话 ID。
	 * @param userSeq 起始用户消息序号。
	 * @returns 完成 Promise。
	 */
	async clearAfterSeq(sessionId: string, userSeq: number): Promise<void> {
		for (const key of this.pending.keys()) {
			const [, seq] = key.split(':');
			if (key.startsWith(`${sessionId}:`) && Number(seq) >= userSeq) {
				this.pending.delete(key);
			}
		}
		const sessionDir = path.join(this.baseDir, sessionId);
		const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
		await Promise.all(entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name) && Number(entry.name) >= userSeq)
			.map((entry) => fs.rm(path.join(sessionDir, entry.name), { recursive: true, force: true })));
		logger.log(`[ChangeJournal] 清理回合变更 sessionId=${sessionId} userSeq>=${userSeq}`);
	}

	/**
	 * 获取某回合的内存聚合容器。
	 * @param sessionId 会话 ID。
	 * @param userSeq 用户消息序号。
	 * @returns 文件聚合映射。
	 */
	private pendingFiles(sessionId: string, userSeq: number): Map<string, PendingFile> {
		const key = this.turnKey(sessionId, userSeq);
		let files = this.pending.get(key);
		if (!files) {
			files = new Map();
			this.pending.set(key, files);
		}
		return files;
	}

	/**
	 * 读取 UTF-8 文本；不存在、目录或读取失败时返回 null。
	 * @param filePath 文件绝对路径。
	 * @returns 文本或 null。
	 */
	private async readText(filePath: string): Promise<string | null> {
		try {
			return await fs.readFile(filePath, 'utf8');
		} catch {
			return null;
		}
	}

	/**
	 * 读取并校验变更集清单。
	 * @param sessionId 会话 ID。
	 * @param changeSetId 变更集 ID。
	 * @returns 清单或 undefined。
	 */
	private async readManifest(sessionId: string, changeSetId: string): Promise<PersistedChangeSet | undefined> {
		if (!/^(?:\d+|session)$/.test(changeSetId)) {
			return undefined;
		}
		try {
			return JSON.parse(await fs.readFile(path.join(this.changeSetDir(sessionId, changeSetId), 'manifest.json'), 'utf8')) as PersistedChangeSet;
		} catch {
			return undefined;
		}
	}

	/**
	 * 构造内存回合键。
	 * @param sessionId 会话 ID。
	 * @param userSeq 用户消息序号。
	 * @returns 回合键。
	 */
	private turnKey(sessionId: string, userSeq: number): string {
		return `${sessionId}:${userSeq}`;
	}

	/**
	 * 获取变更集目录。
	 * @param sessionId 会话 ID。
	 * @param changeSetId 变更集 ID。
	 * @returns 目录绝对路径。
	 */
	private changeSetDir(sessionId: string, changeSetId: string): string {
		return path.join(this.baseDir, sessionId, changeSetId);
	}

	/**
	 * 获取会话基线目录。
	 * @param sessionId 会话 ID。
	 * @returns 会话基线绝对目录。
	 */
	private baselineDir(sessionId: string): string {
		return path.join(this.baseDir, sessionId, 'baseline');
	}

	/**
	 * 读取会话基线清单。
	 * @param sessionId 会话 ID。
	 * @returns 基线清单或 undefined。
	 */
	private async readBaseline(sessionId: string): Promise<SessionBaseline | undefined> {
		try {
			return JSON.parse(await fs.readFile(path.join(this.baselineDir(sessionId), 'manifest.json'), 'utf8')) as SessionBaseline;
		} catch {
			return undefined;
		}
	}

	/**
	 * 扫描可审查的工作区文本文件。
	 * @param workspaceRoot 工作区根目录。
	 * @returns 相对路径到文本内容的映射。
	 */
	private async scanWorkspace(workspaceRoot: string): Promise<Map<string, string>> {
		const startedAt = Date.now();
		const gitPaths = await this.listGitWorkspacePaths(workspaceRoot);
		if (gitPaths) {
			const files = await this.readWorkspaceFiles(workspaceRoot, gitPaths);
			logger.log(`[ChangeJournal] Git 清单扫描完成 root=${workspaceRoot} candidates=${gitPaths.length} files=${files.size} duration_ms=${Date.now() - startedAt}`);
			return files;
		}
		const fallbackPaths = await this.listFallbackWorkspacePaths(workspaceRoot);
		const files = await this.readWorkspaceFiles(workspaceRoot, fallbackPaths);
		logger.log(`[ChangeJournal] 非 Git 工作区扫描完成 root=${workspaceRoot} candidates=${fallbackPaths.length} files=${files.size} duration_ms=${Date.now() - startedAt}`);
		return files;
	}

	/**
	 * 使用 Git 索引与忽略规则列出已跟踪和未跟踪文件，已提交后的文件仍会保留在清单中。
	 * @param workspaceRoot 工作区根目录。
	 * @returns Git 文件相对路径；非 Git 工作区或命令失败时返回 undefined。
	 */
	private async listGitWorkspacePaths(workspaceRoot: string): Promise<string[] | undefined> {
		try {
			const git = simpleGit(workspaceRoot);
			if (!await git.checkIsRepo()) {
				return undefined;
			}
			const output = await git.raw(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
			return output.split('\0').filter(Boolean);
		} catch (error) {
			logger.error(`[ChangeJournal] Git 文件清单读取失败，使用目录扫描 root=${workspaceRoot}`, error);
			return undefined;
		}
	}

	/**
	 * 为非 Git 工作区递归列出候选文件，并跳过常见依赖、缓存和构建目录。
	 * @param workspaceRoot 工作区根目录。
	 * @returns 候选文件相对路径。
	 */
	private async listFallbackWorkspacePaths(workspaceRoot: string): Promise<string[]> {
		const paths: string[] = [];
		const walk = async (directory: string): Promise<void> => {
			const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
			for (const entry of entries) {
				const absolutePath = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					if (!EXCLUDED_WORKSPACE_DIRECTORIES.has(entry.name)) {
						await walk(absolutePath);
					}
				} else if (entry.isFile()) {
					paths.push(path.relative(workspaceRoot, absolutePath).split(path.sep).join('/'));
				}
			}
		};
		await walk(workspaceRoot);
		return paths;
	}

	/**
	 * 批量读取候选路径中的小型文本文件。
	 * @param workspaceRoot 工作区根目录。
	 * @param relativePaths 候选文件相对路径。
	 * @returns 相对路径到文本内容的映射。
	 */
	private async readWorkspaceFiles(workspaceRoot: string, relativePaths: readonly string[]): Promise<Map<string, string>> {
		const files = new Map<string, string>();
		for (let start = 0; start < relativePaths.length; start += 32) {
			const batch = relativePaths.slice(start, start + 32);
			await Promise.all(batch.map(async (relativePath) => {
				const absolutePath = path.join(workspaceRoot, relativePath);
				const stat = await fs.stat(absolutePath).catch(() => undefined);
				if (!stat?.isFile() || stat.size > MAX_SNAPSHOT_FILE_BYTES) {
					return;
				}
				const content = await this.readText(absolutePath);
				if (content === null || content.includes('\0')) {
					return;
				}
				files.set(relativePath.split(path.sep).join('/'), content);
			}));
		}
		return files;
	}

	/**
	 * 将前后快照写为可供变更页读取的清单和文件内容。
	 * @param sessionId 会话 ID。
	 * @param id 变更集 ID。
	 * @param userSeq 来源用户消息序号。
	 * @param entries 文件前后内容条目。
	 * @returns 持久化变更集清单。
	 */
	private async persistChangeSet(sessionId: string, id: string, userSeq: number, entries: readonly { readonly relativePath: string; readonly before: string | null; readonly after: string | null }[]): Promise<PersistedChangeSet> {
		const setDir = this.changeSetDir(sessionId, id);
		const filesDir = path.join(setDir, 'files');
		await fs.rm(setDir, { recursive: true, force: true });
		await fs.mkdir(filesDir, { recursive: true });
		const files: PersistedFile[] = [];
		for (const [index, entry] of entries.entries()) {
			const before = entry.before ?? '';
			const after = entry.after ?? '';
			const beforeFile = `files/${index}.before`;
			const afterFile = `files/${index}.after`;
			await Promise.all([
				fs.writeFile(path.join(setDir, beforeFile), before, 'utf8'),
				fs.writeFile(path.join(setDir, afterFile), after, 'utf8'),
			]);
			const stats = calculateLineStats(before, after);
			files.push({
				id: String(index), relativePath: entry.relativePath,
				status: entry.before === null ? 'added' : entry.after === null ? 'deleted' : 'modified',
				additions: stats.additions, deletions: stats.deletions, beforeFile, afterFile,
			});
		}
		const summary = buildSummary(id, userSeq, files);
		await fs.writeFile(path.join(setDir, 'manifest.json'), JSON.stringify(summary, null, 2), 'utf8');
		return summary;
	}
}

/**
 * 计算文本 diff 的新增和删除行数。
 * @param before 修改前内容。
 * @param after 修改后内容。
 * @returns 增删行统计。
 */
function calculateLineStats(before: string, after: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const part of diffLines(before, after)) {
		const lines = part.value === '' ? 0 : part.value.split('\n').filter((line, index, all) => line !== '' || index < all.length - 1).length;
		if (part.added) {
			additions += lines;
		}
		if (part.removed) {
			deletions += lines;
		}
	}
	return { additions, deletions };
}

/**
 * 构造可持久化变更集清单。
 * @param id 变更集 ID。
 * @param userSeq 来源用户消息序号。
 * @param files 文件条目。
 * @returns 完整清单。
 */
function buildSummary(id: string, userSeq: number, files: readonly PersistedFile[]): PersistedChangeSet {
	return {
		id,
		userSeq,
		files,
		fileCount: files.length,
		additions: files.reduce((sum, file) => sum + file.additions, 0),
		deletions: files.reduce((sum, file) => sum + file.deletions, 0),
	};
}

/**
 * 剥离快照文件定位后返回对外概览。
 * @param summary 持久化清单。
 * @returns 对外概览。
 */
function toSummary(summary: PersistedChangeSet): ChangeSetSummary {
	return {
		...summary,
		files: summary.files.map(({ beforeFile: _beforeFile, afterFile: _afterFile, ...file }) => file),
	};
}
