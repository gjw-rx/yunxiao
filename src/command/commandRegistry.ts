/**
 * Command 注册表 - 保留物理作用域快照并提供运行时生效命令集合。
 *
 * 同名合并规则：项目 Command 覆盖全局 Command。注册表同时保留两个物理作用域
 * 的完整快照（含被覆盖的全局项），供设置页分别展示与编辑。
 */
import type { Command, CommandScope, CommandScopeSnapshot, CommandSnapshot } from './types';
import * as logger from '../logger';

/** 运行时生效命令的查询结果（含覆盖状态）。 */
export interface EffectiveCommand {
	/** 生效的命令定义（项目覆盖全局后的项） */
	readonly command: Command;
	/** 该名称是否被项目同名命令覆盖（true 表示当前生效项来自项目作用域） */
	readonly overridden: boolean;
}

/**
 * Command 注册表：加载快照 → 合并为生效集合，并保留物理快照供设置页展示。
 */
export class CommandRegistry {
	private _global = new Map<string, Command>();
	private _project = new Map<string, Command>();
	private _globalDir?: string;
	private _projectDir?: string;

	/**
	 * 用最新双作用域快照重建注册表（物理快照与生效集合一并更新）。
	 *
	 * @param snapshot 双作用域命令快照
	 */
	reload(snapshot: CommandSnapshot): void {
		const global = new Map(snapshot.global.commands.map((c) => [c.name, c]));
		const project = new Map((snapshot.project?.commands ?? []).map((c) => [c.name, c]));
		this._global = global;
		this._project = project;
		this._globalDir = snapshot.global.directory;
		this._projectDir = snapshot.project?.directory;
		logger.log(
			`[CommandRegistry] 注册表已重建 global=${global.size} project=${project.size} 生效数=${this.list().length}`,
		);
	}

	/**
	 * 按名获取生效 Command（项目覆盖全局；都不存在返回 undefined）。
	 *
	 * @param name 命令名
	 * @returns 生效的 Command；未找到返回 undefined
	 */
	get(name: string): Command | undefined {
		return this._project.get(name) ?? this._global.get(name);
	}

	/**
	 * 按名获取生效 Command 及其覆盖状态。
	 *
	 * @param name 命令名
	 * @returns 生效命令与覆盖状态；未找到返回 undefined
	 */
	getEffective(name: string): EffectiveCommand | undefined {
		const project = this._project.get(name);
		if (project) {
			return { command: project, overridden: true };
		}
		const global = this._global.get(name);
		if (global) {
			return { command: global, overridden: false };
		}
		return undefined;
	}

	/**
	 * 列出生效命令集合（项目覆盖全局后的去重结果，按名称排序）。
	 *
	 * @returns 生效命令列表
	 */
	list(): Command[] {
		const merged = new Map<string, Command>();
		for (const [name, command] of this._global) {
			merged.set(name, command);
		}
		for (const [name, command] of this._project) {
			merged.set(name, command);
		}
		return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * 列出全局作用域物理快照中的全部命令（含被项目覆盖的项）。
	 *
	 * @returns 全局命令列表
	 */
	listGlobal(): Command[] {
		return [...this._global.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * 列出项目作用域物理快照中的全部命令。
	 *
	 * @returns 项目命令列表（未打开工作区时为空）
	 */
	listProject(): Command[] {
		return [...this._project.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * 判断某名称是否被项目作用域同名命令覆盖（仅全局存在该项目为 true）。
	 *
	 * @param name 命令名
	 * @returns 被覆盖返回 true
	 */
	isOverridden(name: string): boolean {
		return this._global.has(name) && this._project.has(name);
	}

	/**
	 * 获取某命令在当前注册表中所属的物理作用域（用于设置页区分来源）。
	 *
	 * @param name 命令名
	 * @returns 作用域；不存在返回 undefined
	 */
	getScope(name: string): CommandScope | undefined {
		if (this._project.has(name)) {
			return 'project';
		}
		if (this._global.has(name)) {
			return 'global';
		}
		return undefined;
	}

	/**
	 * 获取全局命令目录绝对路径（设置页展示实际目录）。
	 *
	 * @returns 全局目录；未加载时为 undefined
	 */
	getGlobalDirectory(): string | undefined {
		return this._globalDir;
	}

	/**
	 * 获取项目命令目录绝对路径（设置页展示实际目录；未打开工作区时缺省）。
	 *
	 * @returns 项目目录；未加载或未打开工作区时为 undefined
	 */
	getProjectDirectory(): string | undefined {
		return this._projectDir;
	}

	/** 全局作用域物理快照（供上层构建设置页快照）。 */
	getGlobalSnapshot(): CommandScopeSnapshot {
		return { scope: 'global', directory: this._globalDir ?? '', commands: this.listGlobal() };
	}

	/** 项目作用域物理快照（供上层构建设置页快照）。 */
	getProjectSnapshot(): CommandScopeSnapshot {
		return { scope: 'project', directory: this._projectDir ?? '', commands: this.listProject() };
	}
}
