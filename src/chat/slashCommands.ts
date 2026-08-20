/**
 * 斜杠命令数据组装 - 定义斜杠命令分组结构与组装函数。
 *
 * 分组：基础功能（内置静态命令）/ 命令（自定义 Command）/ 子智能体（type=agent 的 Skill）/ SKILL（其余 Skill）。
 * 每个候选携带显式 kind，Webview 据此稳定区分 Command 与 Skill，不再依赖 id 前缀猜测。
 */
import type { Skill } from '../skill/types';
import type { SkillRegistry } from '../skill/skillRegistry';
import type { CommandRegistry } from '../command/commandRegistry';
import type { CommandScope, SlashCandidateKind } from '../webview-ui/protocol';

/** 单个斜杠命令。 */
export interface SlashCommand {
	/** 唯一标识（如 basic.new-session / skill.<name> / command.<name>） */
	readonly id: string;
	/** 命令词（不含 /），用于过滤与回填，如 new、plan */
	readonly command: string;
	/** 展示名 */
	readonly label: string;
	/** 副标题说明 */
	readonly description?: string;
	/** true=选中即发送；false=回填输入框由用户编辑后发送 */
	readonly send: boolean;
	/** 显式候选类型 */
	readonly kind: SlashCandidateKind;
	/** 自定义 Command 的生效来源作用域（kind=command 时存在） */
	readonly sourceScope?: CommandScope;
	/** 可选特殊动作：直接触发扩展侧命令而非发消息 */
	readonly action?: 'newSession' | 'stopStream' | 'switchModel' | 'compactContext' | 'planMode';
}

/** 斜杠命令分组。 */
export interface SlashCommandGroup {
	/** 分组标识（基础功能 / 命令 / 子智能体 / SKILL） */
	readonly id: 'basic' | 'commands' | 'agents' | 'skills';
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
		kind: 'basic',
		action: 'newSession',
	},
	{
		id: 'basic.stop',
		command: 'stop',
		label: '停止回复',
		description: '停止当前回复',
		send: true,
		kind: 'basic',
		action: 'stopStream',
	},
	{
		id: 'basic.switch-model',
		command: 'model',
		label: '切换模型',
		description: '切换当前对话使用的模型',
		send: true,
		kind: 'basic',
		action: 'switchModel',
	},
	{
		id: 'basic.compact',
		command: 'compact',
		label: '压缩上下文',
		description: '立即压缩当前会话的上下文',
		send: true,
		kind: 'basic',
		action: 'compactContext',
	},
	{
		id: 'basic.plan-mode',
		command: 'plan',
		label: 'Plan 模式',
		description: '进入或退出只读规划模式（不发送消息）',
		send: true,
		kind: 'basic',
		action: 'planMode',
	},
	{
		id: 'basic.help',
		command: 'help',
		label: '帮助',
		description: '了解插件可用能力',
		send: true,
		kind: 'basic',
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
		kind: skill.type === 'agent' ? 'agent' : 'skill',
	};
}

/**
 * 将注册表中的生效 Command 转换为斜杠命令（不携带正文，仅轻量元数据）。
 *
 * @param commandRegistry Command 注册表
 * @returns 命令分组候选列表
 */
function commandRegistryToCommands(commandRegistry?: CommandRegistry): SlashCommand[] {
	if (!commandRegistry) {
		return [];
	}
	return commandRegistry.list().map((command) => {
		const effective = commandRegistry.getEffective(command.name);
		// 描述标注当前生效来源，帮助用户识别同名覆盖
		const sourceLabel = effective?.overridden ? '（项目覆盖全局）' : command.scope === 'project' ? '（项目）' : '（全局）';
		return {
			id: `command.${command.name}`,
			command: command.name,
			label: command.name,
			description: command.description ? `${command.description}${sourceLabel}` : sourceLabel,
			send: false,
			kind: 'command',
			sourceScope: command.scope,
		};
	});
}

/**
 * 组装斜杠命令分组（基础功能 / 命令 / 子智能体 / SKILL）。
 * 始终返回四个分组，空分组对应 commands 为空数组。
 *
 * @param skillRegistry Skill 注册表（可选，未装配时仅基础功能与命令分组有内容）
 * @param commandRegistry Command 注册表（可选，未装配时命令分组为空）
 * @returns 四个分组的命令数据
 */
export function buildSlashCommandGroups(
	skillRegistry?: SkillRegistry,
	commandRegistry?: CommandRegistry,
): SlashCommandGroup[] {
	const skills = skillRegistry?.list() ?? [];
	return [
		{ id: 'basic', label: '基础功能', commands: BASIC_COMMANDS },
		{ id: 'commands', label: '命令', commands: commandRegistryToCommands(commandRegistry) },
		{
			id: 'agents',
			label: '子智能体',
			commands: skills.filter((s) => s.type === 'agent').map(skillToCommand),
		},
		{
			id: 'skills',
			label: 'SKILL',
			commands: skills.filter((s) => s.type !== 'agent').map(skillToCommand),
		},
	];
}
