/**
 * SystemPrompt 测试 - 覆盖 Agent 生态项目规则（<agent_project_rules>）注入与生态规则互斥。
 */
import * as assert from 'assert';
import { buildSystemPrompt, DEFAULT_AGENT_PROMPT } from '../../agent/systemPrompt';
import type { ProjectRules } from '../../agent/projectRules';
import type { TraeRules } from '../../agent/traeRules';
import type { Skill } from '../../skill/types';

/** 构造最小 SystemPromptContext。 */
function baseContext(overrides: {
	projectRules?: ProjectRules | null;
	traeRules?: TraeRules | null;
	agentProjectRules?: ProjectRules | null;
	skills?: Skill[];
} = {}) {
	return {
		skills: overrides.skills ?? [],
		workspaceRoot: '/ws',
		platform: 'win32',
		date: '2026-08-13',
		projectRules: overrides.projectRules ?? null,
		traeRules: overrides.traeRules ?? null,
		agentProjectRules: overrides.agentProjectRules ?? null,
	};
}

describe('buildSystemPrompt - Agent 项目规则', () => {
	it('agent 来源注入 <agent_project_rules> 段并标注来源与遵循声明', () => {
		const prompt = buildSystemPrompt(
			baseContext({ agentProjectRules: { source: 'AGENTS.md', content: '# Agent 规范' } }),
		);
		assert.ok(prompt.includes('<agent_project_rules>'), '应包含 <agent_project_rules> 段');
		assert.ok(prompt.includes('</agent_project_rules>'));
		assert.ok(prompt.includes('# Agent 规范'));
		assert.ok(prompt.includes('来源：AGENTS.md'));
		assert.ok(prompt.includes('开发工作必须遵循'));
		assert.ok(!prompt.includes('<project_rules>'), 'agent 来源不应注入 Claude <project_rules>');
		assert.ok(!prompt.includes('<trae_rules>'), 'agent 来源不应注入 <trae_rules>');
	});

	it('claude 来源共存时仅注入 <project_rules>，不注入 agent 段', () => {
		const prompt = buildSystemPrompt(
			baseContext({ projectRules: { source: 'CLAUDE.md', content: '# Claude 规范' } }),
		);
		assert.ok(prompt.includes('<project_rules>'));
		assert.ok(prompt.includes('# Claude 规范'));
		assert.ok(!prompt.includes('<agent_project_rules>'));
		assert.ok(!prompt.includes('<trae_rules>'));
	});

	it('trae 来源共存时仅注入 <trae_rules>，不注入 agent 段', () => {
		const prompt = buildSystemPrompt(
			baseContext({ traeRules: { sources: ['.trae/rules/a.md'], content: '# Trae 规则' } }),
		);
		assert.ok(prompt.includes('<trae_rules>'));
		assert.ok(prompt.includes('# Trae 规则'));
		assert.ok(!prompt.includes('<agent_project_rules>'));
		assert.ok(!prompt.includes('<project_rules>'));
	});

	it('agent 规则缺失时不注入任何生态规则段', () => {
		const prompt = buildSystemPrompt(baseContext({ agentProjectRules: null }));
		assert.ok(!prompt.includes('<agent_project_rules>'));
		assert.ok(!prompt.includes('<project_rules>'));
		assert.ok(!prompt.includes('<trae_rules>'));
	});

	it('更新后重建提示词包含最新内容（每次构建重新读取）', () => {
		const first = buildSystemPrompt(
			baseContext({ agentProjectRules: { source: 'AGENTS.md', content: 'v1' } }),
		);
		const second = buildSystemPrompt(
			baseContext({ agentProjectRules: { source: 'AGENTS.md', content: 'v2' } }),
		);
		assert.ok(first.includes('v1'));
		assert.ok(second.includes('v2'));
		assert.ok(!second.includes('v1'));
	});

	it('不注入任何规则时仍包含默认 Agent 提示词', () => {
		const prompt = buildSystemPrompt(baseContext());
		assert.ok(prompt.startsWith(DEFAULT_AGENT_PROMPT.trim()));
	});
});
