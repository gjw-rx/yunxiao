/**
 * 配置来源管理 - 「配置来源」单选（none / claude / trae）的私有存储读写。
 *
 * Claude 与 Trae 的配置（SKILL 同步 + 项目规则注入）二选一：
 * - none：不加载任何生态配置
 * - claude：加载 Claude 目录 SKILL 与项目 CLAUDE.md/AGENTS.md 规范（默认）
 * - trae：加载 Trae 目录 SKILL 与项目 .trae/rules 规则
 *
 * 配置来源存入扩展私有 globalState，不再通过 `yunxiaoAgent.sync.source` VS Code 配置项读写。
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as logger from '../logger';

/** 配置来源取值：none / claude / trae 三选一 */
export type SyncSource = 'none' | 'claude' | 'trae';

/** 配置来源默认值（默认 claude，加载 Claude 项目 Skill 目录）。 */
export const DEFAULT_SYNC_SOURCE: SyncSource = 'claude';

/** 合法取值集合（用于校验配置值，非法回退默认） */
const VALID_SOURCES: readonly SyncSource[] = ['none', 'claude', 'trae'];

/** 配置来源在 globalState 中的键名。 */
const SYNC_SOURCE_STATE_KEY = 'yunxiaoAgent.syncSource';

/** 自定义 Skill 加载目录在 globalState 中的键名。 */
const SKILL_DIRECTORIES_STATE_KEY = 'yunxiaoAgent.skillDirectories';

/** 自定义 Skill 加载目录默认值（相对工作区根）。 */
export const DEFAULT_SKILL_DIRECTORIES: readonly string[] = ['.vscode/skills'];

/**
 * 归一化用户配置的 Skill 目录：仅保留相对工作区根且不越级的非空路径，并去重。
 *
 * @param raw 原始目录配置
 * @returns 可安全拼接到工作区根的目录列表
 */
export function normalizeSkillDirectories(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [...DEFAULT_SKILL_DIRECTORIES];
	}
	const directories = raw
		.filter((entry): entry is string => typeof entry === 'string')
		.filter((entry) => entry.trim().length > 0)
		.map((entry) => path.normalize(entry.trim()))
		.filter((entry) => entry && !path.isAbsolute(entry) && entry !== '..' && !entry.startsWith(`..${path.sep}`))
		.map((entry) => entry.split(path.sep).join('/'));
	return [...new Set(directories)];
}

/**
 * 读取「配置来源」单选值。枚举外值回退默认 `claude` 并记录日志。
 *
 * @param globalState 扩展私有持久化状态
 * @returns 配置来源（none / claude / trae）
 */
export function getSyncSource(globalState: vscode.Memento): SyncSource {
	const raw = globalState.get<SyncSource>(SYNC_SOURCE_STATE_KEY, DEFAULT_SYNC_SOURCE);
	const source = VALID_SOURCES.includes(raw) ? raw : DEFAULT_SYNC_SOURCE;
	if (source !== raw) {
		logger.log(`[SyncConfig] 配置来源非法 raw=${String(raw)}，回退默认 ${DEFAULT_SYNC_SOURCE}`);
	}
	logger.log(`[SyncConfig] 读取配置来源 source=${source}`);
	return source;
}

/**
 * 校验并写入「配置来源」单选值。枚举外值拒绝写入并保持既有配置不变。
 *
 * @param globalState 扩展私有持久化状态
 * @param source 待保存的配置来源
 * @returns 保存后生效的配置来源（非法输入时返回既有值）
 */
export function setSyncSource(globalState: vscode.Memento, source: SyncSource): SyncSource {
	if (!VALID_SOURCES.includes(source)) {
		logger.error(`[SyncConfig] 拒绝保存非法配置来源 source=${String(source)}`);
		return getSyncSource(globalState);
	}
	void globalState.update(SYNC_SOURCE_STATE_KEY, source);
	logger.log(`[SyncConfig] 配置来源已保存 source=${source}`);
	return source;
}

/**
 * 读取用户配置的 Skill 加载目录。目录均相对工作区根；存储无效时回退默认目录。
 *
 * @param globalState 扩展私有持久化状态
 * @returns 已归一化的 Skill 加载目录列表
 */
export function getSkillDirectories(globalState: vscode.Memento): string[] {
	const raw = globalState.get<unknown>(SKILL_DIRECTORIES_STATE_KEY, DEFAULT_SKILL_DIRECTORIES);
	const directories = normalizeSkillDirectories(raw);
	logger.log(`[SyncConfig] 读取 Skill 加载目录 count=${directories.length}`);
	return directories;
}

/**
 * 保存用户配置的 Skill 加载目录。非法、绝对或越级目录会被忽略。
 *
 * @param globalState 扩展私有持久化状态
 * @param directories 待保存的目录列表
 * @returns 保存后生效的目录列表
 */
export function setSkillDirectories(globalState: vscode.Memento, directories: readonly string[]): string[] {
	const normalized = normalizeSkillDirectories(directories);
	void globalState.update(SKILL_DIRECTORIES_STATE_KEY, normalized);
	logger.log(`[SyncConfig] Skill 加载目录已保存 count=${normalized.length}`);
	return normalized;
}
