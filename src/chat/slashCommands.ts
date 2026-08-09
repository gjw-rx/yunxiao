/**
 * 斜杠命令数据组装 - 定义斜杠命令分组结构与组装函数。
 *
 * 分组：基础功能（内置静态命令）/ 子智能体（type=agent 的 Skill）/ SKILL与命令（其余 Skill）。
 */
import type { Skill } from '../skill/types';
import type { SkillRegistry } from '../skill/skillRegistry';

/** 单个斜杠命令。 */
export interface SlashCommand {
	/** 唯一标识（如 basic.new-session / skill.<name>） */
	readonly id: string;
	/** 命令词（不含 /），用于过滤与回填，如 new、plan */
	readonly command: string;
	/** 展示名 */
	readonly label: string;
	/** 副标题说明 */
	readonly description?: string;
	/** true=选中即发送；false=回填输入框由用户编辑后发送 */
	readonly send: boolean;
	/** 可选特殊动作：直接触发扩展侧命令而非发消息 */
	readonly action?: 'newSession' | 'stopStream';
}

/** 斜杠命令分组。 */
export interface SlashCommandGroup {
	/** 分组标识 */
	readonly id: 'basic' | 'agents' | 'skills';
	/** 分组展示名 */
	readonly label: string;
	/** 组内命令 */
	readonly commands: readonly SlashCommand[];
}

/** 基础功能静态命令表（内置快捷操作）。 */
const BASIC_COMMANDS: readonly SlashCommand[] = [
	{
		id: 'basic.new-session',
		command: 'new',
		label: '新建会话',
		description: '创建新会话',
		send: true,
		action: 'newSession',
	},
	{
		id: 'basic.stop',
		command: 'stop',
		label: '停止回复',
		description: '停止当前回复',
		send: true,
		action: 'stopStream',
	},
	{
		id: 'basic.help',
		command: 'help',
		label: '帮助',
		description: '了解插件可用能力',
		send: true,
	},
];

/**
 * 将 Skill 转换为斜杠命令（命令词 = Skill 名称，选中即发送）。
 *
 * @param skill Skill 定义
 * @returns 对应的斜杠命令
 */
function skillToCommand(skill: Skill): SlashCommand {
	return {
		id: `skill.${skill.name}`,
		command: skill.name,
		label: skill.name,
		description: skill.description,
		send: true,
	};
}

/**
 * 组装斜杠命令分组（基础功能 / 子智能体 / SKILL与命令）。
 * 始终返回三个分组，子智能体或 SKILL 为空时对应 commands 为空数组。
 *
 * @param skillRegistry Skill 注册表（可选，未装配时仅返回基础功能分组内容为空）
 * @returns 三个分组的命令数据
 */
export function buildSlashCommandGroups(skillRegistry?: SkillRegistry): SlashCommandGroup[] {
	const skills = skillRegistry?.list() ?? [];
	return [
		{ id: 'basic', label: '基础功能', commands: BASIC_COMMANDS },
		{
			id: 'agents',
			label: '子智能体',
			commands: skills.filter((s) => s.type === 'agent').map(skillToCommand),
		},
		{
			id: 'skills',
			label: 'SKILL与命令',
			commands: skills.filter((s) => s.type !== 'agent').map(skillToCommand),
		},
	];
}
