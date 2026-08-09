/**
 * 配置来源管理 - 读取「配置来源」单选（yunxiaoAgent.sync.source）。
 *
 * Claude 与 Trae 的配置（SKILL 同步 + 项目规则注入）二选一：
 * - none：不加载任何生态配置（默认）
 * - claude：加载 Claude 目录 SKILL 与项目 CLAUDE.md/AGENTS.md 规范
 * - trae：加载 Trae 目录 SKILL 与项目 .trae/rules 规则
 *
 * 复用 modelConfig.ts 的 getConfiguration + 默认值 + onDidChangeConfiguration 模式。
 */
import * as vscode from 'vscode';
import * as logger from '../logger';

/** 配置节：yunxiaoAgent.sync */
const CONFIG_SECTION = 'yunxiaoAgent.sync';

/** 配置来源取值：none / claude / trae 三选一 */
export type SyncSource = 'none' | 'claude' | 'trae';

/** 配置来源默认值（默认关闭，避免隐式读取用户 home 目录） */
const DEFAULT_SYNC_SOURCE: SyncSource = 'none';

/** 合法取值集合（用于校验配置值，非法回退默认） */
const VALID_SOURCES: readonly SyncSource[] = ['none', 'claude', 'trae'];

/**
 * 读取「配置来源」单选值。
 *
 * @returns 配置来源（none / claude / trae）
 */
export function getSyncSource(): SyncSource {
	const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<SyncSource>('source', DEFAULT_SYNC_SOURCE);
	const source = VALID_SOURCES.includes(raw) ? raw : DEFAULT_SYNC_SOURCE;
	logger.log(`[SyncConfig] 读取配置来源 source=${source}`);
	return source;
}

/**
 * 监听「配置来源」变更，仅当 `yunxiaoAgent.sync.*` 配置变化时触发回调。
 *
 * @param callback 配置变更回调（无参）
 * @returns 可释放的订阅
 */
export function onSyncConfigChange(callback: () => void): vscode.Disposable {
	return vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration(CONFIG_SECTION)) {
			logger.log(`[SyncConfig] 检测到配置来源变更`);
			callback();
		}
	});
}
