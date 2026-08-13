/**
 * SystemPrompt 测试 - 覆盖项目规范多来源标注、trae 规则并存注入与缺省降级。
 */
import * as assert from 'assert';
import { buildSystemPrompt, type SystemPromptContext } from '../../agent/systemPrompt';

/** 构造最小 SystemPromptContext。 */
function baseContext(overrides: Partial<SystemPromptContext> = {}): SystemPromptContext {
	return {
		skills: [],
		workspaceRoot: 'C:\\fake-workspace',
		platform: 'win32',
		date: '2026-08-13',
		...overrides,
	};
}

describe('buildSystemPrompt', () => {
	it('无项目规范时不注入 project_rules 段落', () => {
		const prompt = buildSystemPrompt(baseContext());
		assert.ok(!prompt.includes('# 项目级规范'));
		assert.ok(!prompt.includes('<project_rules>'));
	});

	it('项目规范多来源时逐项标注来源路径', () => {
		const prompt = buildSystemPrompt(
			baseContext({
				projectRules: {
					sources: ['C:\\Users\\test\\.claude\\AGENTS.md', 'C:\\fake-workspace\\AGENTS.md'],
					content: '# 全局与项目规范',
				},
			}),
		);
		assert.ok(prompt.includes('# 项目级规范'));
		assert.ok(prompt.includes('<project_rules>'));
		assert.ok(prompt.includes('# 全局与项目规范'));
		assert.ok(prompt.includes('C:\\Users\\test\\.claude\\AGENTS.md、C:\\fake-workspace\\AGENTS.md'));
	});

	it('projectRules 与 traeRules 由调用方按来源二选一注入', () => {
		const withProjectRules = buildSystemPrompt(
			baseContext({
				projectRules: {
					sources: ['C:\\fake-workspace\\AGENTS.md'],
					content: '# AGENTS 规范',
				},
			}),
		);
		assert.ok(withProjectRules.includes('# 项目级规范'));
		assert.ok(!withProjectRules.includes('# Trae 项目规则'));

		const withTraeRules = buildSystemPrompt(
			baseContext({
				traeRules: {
					sources: ['.trae/rules/base.md'],
					content: '## 来源: .trae/rules/base.md\n\n# Trae 规则',
				},
			}),
		);
		assert.ok(withTraeRules.includes('# Trae 项目规则'));
		assert.ok(!withTraeRules.includes('# 项目级规范'));
	});

	it('无 skills 时不注入 available_skills 段落', () => {
		const prompt = buildSystemPrompt(baseContext());
		assert.ok(!prompt.includes('<available_skills>'));
	});
});
