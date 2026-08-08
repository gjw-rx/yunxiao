/**
 * 系统提示词构建器 - 函数式拼接 Agent 提示词 + 环境信息 + Skill guidance。
 *
 * 参考 opencode SystemContext 的可组合设计，简化为单函数。
 */
import type { Skill } from '../skill/types';

/** 默认 Agent 系统提示词。 */
export const DEFAULT_AGENT_PROMPT = `You are an AI coding assistant integrated into VSCode. You help users with software engineering tasks by understanding their codebase, making changes, and running commands.

## Capabilities
You have access to tools for:
- File operations (read, write, edit, search, list, delete, move)
- Code intelligence (diagnostics, symbols, references, definitions)
- Terminal execution
- Git operations
- Skill loading

## Guidelines
- Always read files before editing them
- Make surgical changes - touch only what's necessary
- Use tools to verify your changes (diagnostics, tests)
- Explain what you're doing and why
- If unsure, ask for clarification`;

/** buildSystemPrompt 的上下文参数。 */
export interface SystemPromptContext {
	/** Agent 级提示词（覆盖默认）。为空时使用 DEFAULT_AGENT_PROMPT。 */
	readonly agentPrompt?: string;
	/** 可用 Skill 列表 */
	readonly skills: Skill[];
	/** 工作区根目录 */
	readonly workspaceRoot: string;
	/** 操作系统 */
	readonly platform: string;
	/** 当前日期 */
	readonly date: string;
}

/** 构建环境信息段。 */
function buildEnvironmentSection(context: SystemPromptContext): string {
	return [
		'## Environment',
		`- Working directory: ${context.workspaceRoot}`,
		`- Platform: ${context.platform}`,
		`- Date: ${context.date}`,
	].join('\n');
}

/** 构建 Skill guidance 段。skills 为空时返回空字符串。 */
function buildSkillGuidance(skills: readonly Skill[]): string {
	if (skills.length === 0) {
		return '';
	}

	const skillEntries = skills
		.map(
			(s) =>
				`  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`,
		)
		.join('\n');

	return [
		'## Skills',
		'Skills provide specialized instructions and workflows for specific tasks.',
		'Use the skill tool to load a skill when a task matches its description.',
		'',
		'<available_skills>',
		skillEntries,
		'</available_skills>',
	].join('\n');
}

/** 构建完整系统提示词：Agent 提示词 + 环境信息 + Skill guidance。 */
export function buildSystemPrompt(context: SystemPromptContext): string {
	const sections: string[] = [];

	// Agent 级提示词
	sections.push(context.agentPrompt?.trim() || DEFAULT_AGENT_PROMPT);

	// 环境信息
	sections.push(buildEnvironmentSection(context));

	// Skill guidance（为空则跳过）
	const guidance = buildSkillGuidance(context.skills);
	if (guidance) {
		sections.push(guidance);
	}

	return sections.join('\n\n');
}
