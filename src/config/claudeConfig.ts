/**
 * Claude 配置管理 - 读取「同步CLAUDE配置」开关。
 *
 * 复用 modelConfig.ts 的 getConfiguration + 默认值 + onDidChangeConfiguration 模式。
 */
import * as vscode from 'vscode';
import * as logger from '../logger';

/** 配置节：yunxiaoAgent.claude */
const CONFIG_SECTION = 'yunxiaoAgent.claude';

/** 「同步CLAUDE配置」开关默认值（默认关闭，避免隐式读取用户 home 目录） */
const DEFAULT_SYNC_ENABLED = false;

/**
 * 读取「同步CLAUDE配置」开关。
 *
 * @returns 是否开启 Claude 目录 SKILL 同步
 */
export function getSyncEnabled(): boolean {
	const enabled = vscode.workspace
		.getConfiguration(CONFIG_SECTION)
		.get<boolean>('syncEnabled', DEFAULT_SYNC_ENABLED);
	logger.log(`[ClaudeConfig] 读取同步CLAUDE配置 syncEnabled=${enabled}`);
	return enabled;
}

/**
 * 监听「同步CLAUDE配置」变更，仅当 `yunxiaoAgent.claude.*` 配置变化时触发回调。
 *
 * @param callback 配置变更回调（无参）
 * @returns 可释放的订阅
 */
export function onClaudeConfigChange(callback: () => void): vscode.Disposable {
	return vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration(CONFIG_SECTION)) {
			logger.log(`[ClaudeConfig] 检测到同步CLAUDE配置变更`);
			callback();
		}
	});
}
