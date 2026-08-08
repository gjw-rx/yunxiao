/**
 * skill 工具 - LLM 通过工具调用加载 Skill 内容。
 *
 * 权限为 read（免审批），site 为 local。
 * 持有 SkillRegistry 引用，execute 时按 name 查找 Skill 并返回 content。
 */
import {
	BaseTool,
	requireStringArg,
	type ToolContext,
	type ToolExecutionResult,
} from '../tools/baseTool';
import type { ToolSchema } from '../core/types';
import type { SkillRegistry } from './skillRegistry';

export class SkillTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'skill',
		description: 'Load a specialized skill by name. Returns the skill instructions as Markdown text.',
		parameters: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description: 'The name of the skill to load',
				},
			},
			required: ['name'],
		},
		permissions: 'read',
		canParallel: true,
	};

	constructor(private readonly registry: SkillRegistry) {
		super();
	}

	validate(args: Record<string, unknown>): void {
		requireStringArg(args, 'name');
	}

	async execute(
		args: Record<string, unknown>,
		_context: ToolContext,
	): Promise<ToolExecutionResult> {
		const name = args.name as string;
		const skill = this.registry.get(name);

		if (!skill) {
			const available = this.registry.list().map((s) => s.name).join(', ');
			return {
				status: 'error',
				error: `Skill not found: ${name}. Available skills: ${available || '(none)'}`,
			};
		}

		return {
			status: 'success',
			result: skill.content,
		};
	}
}
