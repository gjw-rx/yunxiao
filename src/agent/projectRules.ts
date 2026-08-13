/**
 * Agent 指令文件读取 - 配置来源为 claude 时，加载用户级全局与项目级的 AGENTS.md / CLAUDE.md 作为项目级规范。
 *
 * 对齐 Claude Code 的 AGENTS.md 机制（属于 Claude 生态，跟随「配置来源」= claude）：
 * - 用户级全局：~/.claude/AGENTS.md（回退 ~/.claude/CLAUDE.md）
 * - 项目级：CLAUDE.md 优先（既有行为），回退 AGENTS.md
 *
 * 由 AgentLoop 在配置来源为 claude 时每轮构建系统提示词调用（trae/none 来源不调用），
 * 读取失败静默降级不影响主流程。
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as logger from '../logger';

/** 项目规范定义。 */
export interface ProjectRules {
	/** 来源文件完整路径列表（按注入顺序：用户级全局在前、项目级在后） */
	readonly sources: string[];
	/** 拼接后的规范内容（各来源内容以空行分隔） */
	readonly content: string;
}

/** 单份规范文件大小上限（字节），超出视为过大并跳过该份 */
const PROJECT_RULES_MAX_BYTES = 64 * 1024;

/** 用户级全局候选文件：AGENTS.md 优先，CLAUDE.md 回退 */
const GLOBAL_CANDIDATES = ['.claude/AGENTS.md', '.claude/CLAUDE.md'] as const;

/** 项目级候选文件：CLAUDE.md 优先（向后兼容），AGENTS.md 回退 */
const PROJECT_CANDIDATES = ['CLAUDE.md', 'AGENTS.md'] as const;

/**
 * 读取单份规范文件（存在、单文件、不超限）。任何失败返回 null 并记录日志，不抛异常。
 *
 * @param filePath 规范文件绝对路径
 * @returns 文件内容（utf8）；文件不存在/非文件/超限/读取失败时为 null
 */
async function tryReadRuleFile(filePath: string): Promise<string | null> {
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) {
			return null;
		}
		if (stat.size > PROJECT_RULES_MAX_BYTES) {
			logger.log(`[ProjectRules] ${filePath} 超过大小上限 ${PROJECT_RULES_MAX_BYTES}B，跳过该份`);
			return null;
		}
		const content = await fs.readFile(filePath, 'utf8');
		logger.log(`[ProjectRules] 读取成功 ${filePath} bytes=${content.length}`);
		return content;
	} catch {
		logger.log(`[ProjectRules] 读取 ${filePath} 失败，跳过该份`);
		return null;
	}
}

/**
 * 从候选列表中取第一份可读文件（候选间为「优先/回退」关系，仅取一份）。
 *
 * @param candidates 候选文件绝对路径列表（按优先级排序）
 * @returns 第一份可读文件的来源路径与内容；全部不可读时为 null
 */
async function readFirstRule(
	candidates: readonly string[],
): Promise<{ readonly source: string; readonly content: string } | null> {
	for (const filePath of candidates) {
		const content = await tryReadRuleFile(filePath);
		if (content !== null) {
			return { source: filePath, content };
		}
	}
	return null;
}

/**
 * 加载 Agent 指令文件（项目规范）。
 *
 * 默认加载用户级全局 ~/.claude/AGENTS.md（回退 ~/.claude/CLAUDE.md）与项目级规范
 * （CLAUDE.md 优先、AGENTS.md 回退）。全局在前、项目在后拼接注入，并逐份记录来源路径。
 * 任一份文件过大或读取失败均只跳过该份，不影响其他份；全部缺失时返回 null。
 *
 * @param workspaceRoot 工作区根目录
 * @param options.globalHomeDir 用户主目录（测试注入用，缺省取 os.homedir()）
 * @returns 项目规范，未找到任何可读文件时为 null
 */
export async function loadProjectRules(
	workspaceRoot: string,
	options?: { readonly globalHomeDir?: string },
): Promise<ProjectRules | null> {
	if (!workspaceRoot) {
		return null;
	}
	const homeDir = options?.globalHomeDir ?? os.homedir();

	// 用户级全局（AGENTS.md 优先）与项目级（CLAUDE.md 优先）各取第一份可读文件
	const globalRule = await readFirstRule(GLOBAL_CANDIDATES.map((name) => path.join(homeDir, name)));
	const projectRule = await readFirstRule(PROJECT_CANDIDATES.map((name) => path.join(workspaceRoot, name)));

	const sections: string[] = [];
	const sources: string[] = [];
	for (const rule of [globalRule, projectRule]) {
		if (rule) {
			sources.push(rule.source);
			sections.push(rule.content.trim());
		}
	}

	if (sources.length === 0) {
		logger.log('[ProjectRules] 未找到 Agent 指令文件（用户级 ~/.claude/AGENTS.md、项目级 CLAUDE.md/AGENTS.md）');
		return null;
	}

	const rules: ProjectRules = { sources, content: sections.join('\n\n') };
	logger.log(`[ProjectRules] 加载 Agent 指令完成 来源=${sources.join('、')} bytes=${rules.content.length}`);
	return rules;
}
