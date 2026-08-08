/**
 * Skill 注册表 - Skill 的注册、注销与查询。
 */
import type { Skill } from './types';

export class SkillRegistry {
	private readonly skills = new Map<string, Skill>();

	/** 注册 Skill，同名覆盖。 */
	register(skill: Skill): void {
		this.skills.set(skill.name, skill);
	}

	/** 按名注销 Skill。 */
	unregister(name: string): void {
		this.skills.delete(name);
	}

	/** 按名获取 Skill，未找到返回 undefined。 */
	get(name: string): Skill | undefined {
		return this.skills.get(name);
	}

	/** 列出所有已注册 Skill。 */
	list(): Skill[] {
		return [...this.skills.values()];
	}

	/** 仅列出支持 / 命令触发的 Skill。 */
	listSlashCommands(): Skill[] {
		return this.list().filter((s) => s.slash === true);
	}
}
