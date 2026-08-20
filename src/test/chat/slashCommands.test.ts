/**
 * slashCommands 测试 - 覆盖斜杠命令分组组装逻辑（基础功能/命令/子智能体/SKILL 四分组与显式 kind）。
 */
import * as assert from 'assert';
import { buildSlashCommandGroups } from '../../chat/slashCommands';
import { SkillRegistry } from '../../skill/skillRegistry';
import { CommandRegistry } from '../../command/commandRegistry';
import type { Skill } from '../../skill/types';
import type { Command } from '../../command/types';

function makeSkill(partial: Partial<Skill> & { name: string; description: string }): Skill {
	return { content: 'body', ...partial };
}

/** 构造单条 Command。 @param name 名称。 @param scope 作用域。 @returns Command。 */
function makeCommand(name: string, scope: 'global' | 'project', body: string): Command {
	return { name, scope, body, sourcePath: `/ws/${scope}/${name}.md` };
}

describe('buildSlashCommandGroups', () => {
	it('无 skill 与 command 时四个分组齐全，仅基础功能非空', () => {
		const groups = buildSlashCommandGroups(undefined, undefined);
		assert.strictEqual(groups.length, 4);
		assert.deepStrictEqual(
			groups.map((g) => g.id),
			['basic', 'commands', 'agents', 'skills']
		);
		assert.deepStrictEqual(
			groups.map((g) => g.label),
			['基础功能', '命令', '子智能体', 'SKILL']
		);
		assert.ok(groups[0].commands.length > 0, '基础功能分组应有内置命令');
		assert.strictEqual(groups[1].commands.length, 0, '命令分组应为空');
		assert.strictEqual(groups[2].commands.length, 0, '子智能体分组应为空');
		assert.strictEqual(groups[3].commands.length, 0, 'SKILL 分组应为空');
	});

	it('type=agent 的 skill 归入子智能体分组，其余归入 SKILL，均带显式 kind', () => {
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
		assert.strictEqual(agents?.commands[0].kind, 'agent');
		assert.strictEqual(skills?.commands[0].kind, 'skill');
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

	it('自定义 Command 归入命令分组：kind=command、send=false、不携带正文', () => {
		const commandRegistry = new CommandRegistry();
		commandRegistry.reload({
			global: { scope: 'global', directory: '/ws/global', commands: [makeCommand('review', 'global', '正文')] },
			project: null,
		});
		const groups = buildSlashCommandGroups(undefined, commandRegistry);
		const commands = groups.find((g) => g.id === 'commands');
		assert.ok(commands);
		assert.strictEqual(commands.commands.length, 1);
		const cmd = commands.commands[0];
		assert.strictEqual(cmd.id, 'command.review');
		assert.strictEqual(cmd.command, 'review');
		assert.strictEqual(cmd.kind, 'command');
		assert.strictEqual(cmd.send, false);
		assert.strictEqual(cmd.sourceScope, 'global');
		assert.ok(!JSON.stringify(cmd).includes('正文'), '斜杠候选不得携带 Command 正文');
	});

	it('项目同名覆盖全局时命令分组描述标注覆盖来源', () => {
		const commandRegistry = new CommandRegistry();
		commandRegistry.reload({
			global: { scope: 'global', directory: '/ws/global', commands: [makeCommand('review', 'global', 'g')] },
			project: { scope: 'project', directory: '/ws/project', commands: [makeCommand('review', 'project', 'p')] },
		});
		const groups = buildSlashCommandGroups(undefined, commandRegistry);
		const cmd = groups.find((g) => g.id === 'commands')?.commands[0];
		assert.ok(cmd);
		assert.match(cmd.description ?? '', /项目覆盖全局/);
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

	it('压缩命令：命令词 compact、动作 compactContext、不进入会话文本', () => {
		const groups = buildSlashCommandGroups(undefined);
		const basic = groups.find((group) => group.id === 'basic');
		const command = basic?.commands.find((item) => item.command === 'compact');
		assert.ok(command, '基础功能分组应包含 /compact 命令');
		assert.strictEqual(command.id, 'basic.compact');
		assert.strictEqual(command.action, 'compactContext');
	});
});
