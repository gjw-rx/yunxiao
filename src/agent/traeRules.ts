/**
 * Trae 项目规则读取 - 从项目 .trae/rules 与 .trae-cn/rules 目录加载规则文件。
 *
 * Trae（字节跳动 AI IDE）以 .trae（国际版）/ .trae-cn（国内版）目录存放项目配置，
 * 其中 rules/ 下为 Markdown 规则文件（支持 ≤3 层子目录，frontmatter 可选）。
 * 由 AgentLoop 每轮构建系统提示词时调用，始终生效（读取项目内文件），
 * 读取失败静默降级不影响主流程。
 */
import { promises as fs, type Dirent } from 'fs';
import * as path from 'path';
import * as logger from '../logger';

/** Trae 项目规则定义。 */
export interface TraeRules {
	/** 来源文件相对路径列表（相对工作区根，用于提示词标注） */
	readonly sources: string[];
	/** 拼接后的规则内容 */
	readonly content: string;
}

/** Trae 规则合计大小上限（字节），超出视为过大并跳过注入 */
const TRAE_RULES_MAX_BYTES = 64 * 1024;

/** Trae 规则目录最大递归深度（与 Trae 官方规范一致：≤3 层） */
const MAX_RULES_DEPTH = 3;

/** Trae 配置目录名：国际版 .trae、国内版 .trae-cn */
const TRAE_DIRS = ['.trae', '.trae-cn'] as const;

/**
 * 递归收集目录下所有 Markdown 规则文件（深度 ≤3 层）。
 *
 * 目录不存在或不可读时静默跳过（返回空数组），不抛异常。
 *
 * @param dir 待扫描目录
 * @param depth 当前递归深度（0 起，达到 MAX_RULES_DEPTH 不再下钻）
 * @param results 收集结果（相对路径），原地追加
 */
async function collectRuleFiles(dir: string, depth: number, results: string[]): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		// 目录不存在或不可读
		return;
	}

	// 排序保证扫描顺序确定性（拼接结果稳定）
	entries.sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith('.md')) {
			results.push(path.join(dir, entry.name));
		} else if (entry.isDirectory() && depth + 1 < MAX_RULES_DEPTH) {
			// 子目录：递归下钻（非 .md 文件忽略）
			await collectRuleFiles(path.join(dir, entry.name), depth + 1, results);
		}
	}
}

/**
 * 加载 Trae 项目规则文件。
 *
 * 扫描 `<workspaceRoot>/.trae/rules` 与 `<workspaceRoot>/.trae-cn/rules`
 * （递归 ≤3 层）收集全部 `*.md`，按「## 来源: <相对路径> + 内容」拼接。
 * 规则合计超过大小上限时跳过注入；单文件读取失败跳过该文件。
 * 无规则文件或读取失败时返回 null 并记录日志。
 *
 * @param workspaceRoot 工作区根目录
 * @returns Trae 项目规则，未找到或读取失败时为 null
 */
export async function loadTraeRules(workspaceRoot: string): Promise<TraeRules | null> {
	if (!workspaceRoot) {
		return null;
	}

	const files: string[] = [];
	for (const traeDir of TRAE_DIRS) {
		await collectRuleFiles(path.join(workspaceRoot, traeDir, 'rules'), 0, files);
	}
	if (files.length === 0) {
		logger.log('[TraeRules] 未找到 Trae 规则文件（.trae/rules / .trae-cn/rules）');
		return null;
	}

	// 单文件读取失败跳过该文件；合计大小超限时整体放弃
	const sections: string[] = [];
	const sources: string[] = [];
	let totalBytes = 0;
	for (const filePath of files) {
		let content: string;
		try {
			content = await fs.readFile(filePath, 'utf8');
		} catch {
			logger.log(`[TraeRules] 读取规则文件失败，跳过: ${filePath}`);
			continue;
		}
		totalBytes += content.length;
		if (totalBytes > TRAE_RULES_MAX_BYTES) {
			logger.log(`[TraeRules] 规则合计超过大小上限 ${TRAE_RULES_MAX_BYTES}B，跳过注入`);
			return null;
		}
		sections.push(`## 来源: ${path.relative(workspaceRoot, filePath)}\n\n${content.trim()}`);
		sources.push(path.relative(workspaceRoot, filePath));
	}

	if (sections.length === 0) {
		logger.log('[TraeRules] 全部规则文件读取失败，跳过注入');
		return null;
	}

	const rules: TraeRules = { sources, content: sections.join('\n\n') };
	logger.log(`[TraeRules] 加载 Trae 规则 文件数=${sources.length} bytes=${rules.content.length}`);
	return rules;
}
