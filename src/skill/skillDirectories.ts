/**
 * Skill 目录解析 - 常驻默认加载目录与来源绑定目录的计算。
 *
 * - 常驻默认加载（与「配置来源」解耦，切源不卸载）：项目 .claude/skills + 用户级 ~/.claude/skills
 * - 来源绑定加载（切源时卸载重载）：自定义 Skill 目录始终参与；Trae Skill 目录仅 trae 来源时参与
 */
import * as path from 'path';
import * as os from 'os';
import type { SyncSource } from '../config/syncConfig';

/**
 * 常驻默认加载的 Skill 目录（与配置来源解耦）。
 *
 * 项目 .claude/skills 在前（同名时项目优先），用户级 ~/.claude/skills 在后。
 *
 * @param workspaceRoot 工作区根目录
 * @returns 常驻 Skill 目录绝对路径列表
 */
export function getResidentSkillDirs(workspaceRoot: string): string[] {
	return [
		path.join(workspaceRoot, '.claude', 'skills'),
		path.join(os.homedir(), '.claude', 'skills'),
	];
}

/**
 * 来源绑定的 Skill 目录。
 *
 * 自定义 Skill 目录始终参与；来源为 trae 时追加用户级与项目级 Trae Skill 目录。
 *
 * @param workspaceRoot 工作区根目录
 * @param source 配置来源（none/claude/trae）
 * @param configuredDirs 已拼接为绝对路径的自定义 Skill 目录
 * @returns 来源绑定 Skill 目录绝对路径列表
 */
export function getSourceSkillDirs(
	workspaceRoot: string,
	source: SyncSource,
	configuredDirs: readonly string[],
): string[] {
	const dirs = [...configuredDirs];
	if (source === 'trae') {
		dirs.push(
			path.join(os.homedir(), '.trae', 'skills'),
			path.join(os.homedir(), '.trae-cn', 'skills'),
			path.join(workspaceRoot, '.trae', 'skills'),
			path.join(workspaceRoot, '.trae-cn', 'skills'),
		);
	}
	return dirs;
}
