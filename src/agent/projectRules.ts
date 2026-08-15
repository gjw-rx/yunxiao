/**
 * 项目规范读取 - 从项目根加载 CLAUDE.md（回退 AGENTS.md）或 Agent 生态 AGENTS.md。
 *
 * 由 AgentLoop 每轮构建系统提示词时调用，读取失败静默降级不影响主流程。
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as logger from '../logger';

/** 项目规范定义。 */
export interface ProjectRules {
	/** 来源文件名：CLAUDE.md 或 AGENTS.md */
	readonly source: 'CLAUDE.md' | 'AGENTS.md';
	/** 规范文件内容 */
	readonly content: string;
}

/** 项目规范文件大小上限（字节），超出视为过大并跳过注入 */
const PROJECT_RULES_MAX_BYTES = 64 * 1024;

/** 候选文件查找顺序：CLAUDE.md 优先，AGENTS.md 回退 */
const CANDIDATES = ['CLAUDE.md', 'AGENTS.md'] as const;

/**
 * 加载项目规范文件。
 *
 * 按 CLAUDE.md → AGENTS.md 顺序查找：优先存在的文件；两者都存在时仅读
 * CLAUDE.md（单一来源）；均不存在返回 null。文件过大或读取失败时静默降级
 * 返回 null 并记录日志。
 *
 * @param workspaceRoot 工作区根目录
 * @returns 项目规范，未找到或读取失败时为 null
 */
export async function loadProjectRules(workspaceRoot: string): Promise<ProjectRules | null> {
	if (!workspaceRoot) {
		return null;
	}
	for (const source of CANDIDATES) {
		const filePath = path.join(workspaceRoot, source);
		try {
			const stat = await fs.stat(filePath);
			if (!stat.isFile()) {
				continue;
			}
			if (stat.size > PROJECT_RULES_MAX_BYTES) {
				logger.log(`[ProjectRules] ${source} 超过大小上限 ${PROJECT_RULES_MAX_BYTES}B，跳过注入`);
				return null;
			}
			const content = await fs.readFile(filePath, 'utf8');
			logger.log(`[ProjectRules] 加载项目规范 source=${source} bytes=${content.length}`);
			return { source, content };
		} catch {
			// 文件不存在或不可读：尝试下一个候选
			logger.log(`[ProjectRules] 读取 ${source} 失败，尝试回退`);
		}
	}
	logger.log('[ProjectRules] 未找到项目规范文件（CLAUDE.md / AGENTS.md）');
	return null;
}

/**
 * 加载 Agent 生态项目规则：仅读取工作区根目录的 AGENTS.md。
 *
 * 与 loadProjectRules（CLAUDE.md → AGENTS.md 回退）隔离：agent 来源不将
 * CLAUDE.md 作为候选，也不向子目录或父目录搜索。文件过大或读取失败时
 * 静默降级返回 null 并记录日志，不中断会话。
 *
 * @param workspaceRoot 工作区根目录
 * @returns Agent 项目规则，未找到或读取失败时为 null
 */
export async function loadAgentProjectRules(workspaceRoot: string): Promise<ProjectRules | null> {
	if (!workspaceRoot) {
		return null;
	}
	const filePath = path.join(workspaceRoot, 'AGENTS.md');
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) {
			logger.log('[ProjectRules] AGENTS.md 不是文件，跳过 Agent 规则注入');
			return null;
		}
		if (stat.size > PROJECT_RULES_MAX_BYTES) {
			logger.log(`[ProjectRules] AGENTS.md 超过大小上限 ${PROJECT_RULES_MAX_BYTES}B，跳过 Agent 规则注入`);
			return null;
		}
		const content = await fs.readFile(filePath, 'utf8');
		logger.log(`[ProjectRules] 加载 Agent 项目规则 source=AGENTS.md bytes=${content.length}`);
		return { source: 'AGENTS.md', content };
	} catch {
		logger.log('[ProjectRules] 读取 AGENTS.md 失败，跳过 Agent 规则注入');
		return null;
	}
}
