/**
 * MCP instructions 注入系统提示词测试（任务 11.1）。
 *
 * 覆盖 spec「MCP instructions 快照」场景：
 * - 来源边界：instructions 只来自 mcpInstructions 字段
 * - 空时不含 MCP 段（兼容）
 * - 有时包含 `<mcp_server_instructions>` 标签
 * - 声明不构成安全授权
 */
import * as assert from 'assert';
import { buildSystemPrompt, type SystemPromptContext } from '../../agent/systemPrompt';
import type { Skill } from '../../skill/types';

/** 构造最小 SystemPromptContext。 */
function ctx(opts: { mcpInstructions?: readonly { readonly serverId: string; readonly content: string }[] } = {}): SystemPromptContext {
	return {
		skills: [] as Skill[],
		workspaceRoot: '/test',
		platform: 'linux',
		date: '2026-01-01',
		mcpInstructions: opts.mcpInstructions,
	};
}

describe('MCP instructions 注入系统提示词（11.1）', () => {
	it('空时不含 MCP 段（兼容）', () => {
		const prompt = buildSystemPrompt(ctx());
		assert.ok(!prompt.includes('MCP Server Instructions'), '无 MCP instructions 时不应注入 MCP 段');
		assert.ok(!prompt.includes('<mcp_server_instructions'), '不应包含 mcp_server_instructions 标签');
	});

	it('有时包含 <mcp_server_instructions> 标签', () => {
		const prompt = buildSystemPrompt(ctx({
			mcpInstructions: [
				{ serverId: 'srv-a', content: '使用 search 工具查询' },
				{ serverId: 'srv-b', content: '使用 write 工具写入' },
			],
		}));
		assert.ok(prompt.includes('# MCP Server Instructions'), '应包含 MCP 段标题');
		assert.ok(prompt.includes('<mcp_server_instructions server="srv-a">'), '应包含 srv-a 标签');
		assert.ok(prompt.includes('使用 search 工具查询'), '应包含 srv-a 内容');
		assert.ok(prompt.includes('<mcp_server_instructions server="srv-b">'), '应包含 srv-b 标签');
		assert.ok(prompt.includes('使用 write 工具写入'), '应包含 srv-b 内容');
	});

	it('声明不构成安全授权', () => {
		const prompt = buildSystemPrompt(ctx({
			mcpInstructions: [{ serverId: 'srv', content: 'test' }],
		}));
		assert.ok(prompt.includes('do NOT grant'), '应声明不构成安全授权');
	});

	it('与 AGENTS/Skill 并存', () => {
		const prompt = buildSystemPrompt({
			skills: [{ name: 'test-skill', description: 'test desc', prompt: 'test prompt' } as unknown as Skill],
			workspaceRoot: '/test',
			platform: 'linux',
			date: '2026-01-01',
			mcpInstructions: [{ serverId: 'srv', content: 'MCP 指令' }],
		});
		assert.ok(prompt.includes('<available_skills>'), '应同时包含 Skill 段');
		assert.ok(prompt.includes('<mcp_server_instructions'), '应同时包含 MCP 段');
	});
});
