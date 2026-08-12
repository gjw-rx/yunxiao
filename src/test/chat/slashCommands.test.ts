/**
 * slashCommands 测试 - 覆盖斜杠命令分组组装逻辑。
 */
import * as assert from 'assert';
import { buildSlashCommandGroups } from '../../chat/slashCommands';
import { SkillRegistry } from '../../skill/skillRegistry';
import type { Skill } from '../../skill/types';

function makeSkill(partial: Partial<Skill> & { name: string; description: string }): Skill {
	return { content: 'body', ...partial };
}

describe('buildSlashCommandGroups', () => {
	it('无 skill 时仅基础功能分组非空，三个分组齐全', () => {
		const groups = buildSlashCommandGroups(undefined);
		assert.strictEqual(groups.length, 3);
		assert.deepStrictEqual(
			groups.map((g) => g.id),
			['basic', 'agents', 'skills']
		);
		assert.ok(groups[0].commands.length > 0, '基础功能分组应有内置命令');
		assert.strictEqual(groups[1].commands.length, 0, '子智能体分组应为空');
		assert.strictEqual(groups[2].commands.length, 0, 'SKILL与命令分组应为空');
	});

	it('type=agent 的 skill 归入子智能体分组', () => {
		const registry = new SkillRegistry();
		registry.register(makeSkill({ name: 'agent-x', description: 'agent', type: 'agent' }));
		registry.register(makeSkill({ name: 'skill-x', description: 'skill' }));
		const groups = buildSlashCommandGroups(registry);
		const agents = groups.find((g) => g.id === 'agents');
		const skills = groups.find((g) => g.id === 'skills');
		assert.deepStrictEqual(
			agents?.commands.map((c) => c.command),
			['agent-x']
		);
		assert.deepStrictEqual(
			skills?.commands.map((c) => c.command),
			['skill-x']
		);
	});

	it('skill 命令 send=true 且命令词为 skill 名', () => {
		const registry = new SkillRegistry();
		registry.register(makeSkill({ name: 'plan', description: '计划 skill' }));
		const groups = buildSlashCommandGroups(registry);
		const cmd = groups.find((g) => g.id === 'skills')?.commands[0];
		assert.ok(cmd);
		assert.strictEqual(cmd.command, 'plan');
		assert.strictEqual(cmd.send, true);
		assert.strictEqual(cmd.id, 'skill.plan');
	});

	it('基础功能包含新建会话、停止回复与切换模型动作', () => {
		const groups = buildSlashCommandGroups(undefined);
		const basic = groups.find((g) => g.id === 'basic');
		assert.ok(basic?.commands.some((c) => c.action === 'newSession'));
		assert.ok(basic?.commands.some((c) => c.action === 'stopStream'));
		assert.ok(basic?.commands.some((c) => c.action === 'switchModel'));
	});

	it('切换模型命令：命令词 model、动作 switchModel、不直接发送', () => {
		const groups = buildSlashCommandGroups(undefined);
		const basic = groups.find((g) => g.id === 'basic');
		const cmd = basic?.commands.find((c) => c.command === 'model');
		assert.ok(cmd, '基础功能分组应包含 /model 命令');
		assert.strictEqual(cmd.id, 'basic.switch-model');
		assert.strictEqual(cmd.action, 'switchModel');
		assert.strictEqual(cmd.label, '切换模型');
	});
});
