/**
 * Trae 配置管理 - 读取「同步TRAE配置」开关。
 *
 * 复用 claudeConfig.ts 的 getConfiguration + 默认值 + onDidChangeConfiguration 模式。
 */
import * as vscode from 'vscode';
import * as logger from '../logger';

/** 配置节：yunxiaoAgent.trae */
const CONFIG_SECTION = 'yunxiaoAgent.trae';

/** 「同步TRAE配置」开关默认值（默认关闭，避免隐式读取用户 home 目录） */
const DEFAULT_SYNC_ENABLED = false;

/**
 * 读取「同步TRAE配置」开关。
 *
 * @returns 是否开启 Trae 目录 SKILL 同步
 */
export function getSyncEnabled(): boolean {
	const enabled = vscode.workspace
		.getConfiguration(CONFIG_SECTION)
		.get<boolean>('syncEnabled', DEFAULT_SYNC_ENABLED);
	logger.log(`[TraeConfig] 读取同步TRAE配置 syncEnabled=${enabled}`);
	return enabled;
}

/**
 * 监听「同步TRAE配置」变更，仅当 `yunxiaoAgent.trae.*` 配置变化时触发回调。
 *
 * @param callback 配置变更回调（无参）
 * @returns 可释放的订阅
 */
export function onTraeConfigChange(callback: () => void): vscode.Disposable {
	return vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration(CONFIG_SECTION)) {
			logger.log(`[TraeConfig] 检测到同步TRAE配置变更`);
			callback();
		}
	});
}
