/**
 * Command 存储服务 - 限定固定目录的 Command CRUD、按需建目录与串行重载协调。
 *
 * 职责：
 * - 创建/编辑/删除限定在当前固定作用域目录内，非法名称在写入前拒绝，不修改作用域外文件；
 * - 目录不存在时按需创建；项目作用域在未打开工作区时拒绝写操作；
 * - 激活、CRUD 成功与手动刷新统一通过串行链重载注册表，保证并发操作顺序一致，
 *   所有分支通过统一 logger 记录作用域、名称与路径，不输出正文。
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import type { CommandDirectories } from './commandLoader';
import { loadCommandScopesFromDirs } from './commandLoader';
import { isValidCommandName } from './commandParser';
import { CommandRegistry } from './commandRegistry';
import type { CommandScope, CommandSnapshot } from './types';
import * as logger from '../logger';

/** 创建/编辑 Command 的内容输入。 */
export interface CommandInput {
	/** 命令名（仅 create 使用；由文件名确定唯一标识） */
	readonly name?: string;
	/** 可选描述（缺省清除描述） */
	readonly description?: string;
	/** 正文（必须非空） */
	readonly body: string;
}

/** Command 存储服务：文件 CRUD + 注册表串行重载。 */
export class CommandStore {
	/** 保留物理快照与生效集合的注册表（reload 后由同一份快照更新）。 */
	readonly registry: CommandRegistry;
	private readonly dirs: CommandDirectories;
	/** 串行重载链：所有需要 reload 的操作按顺序执行，避免并发产生不一致快照。 */
	private chain: Promise<void> = Promise.resolve();

	/**
	 * 构造存储服务。
	 *
	 * @param dirs 解析后的固定命令目录集合
	 * @param registry 待更新的 Command 注册表
	 */
	constructor(dirs: CommandDirectories, registry: CommandRegistry) {
		this.dirs = dirs;
		this.registry = registry;
	}

	/**
	 * 返回指定作用域的命令目录；项目作用域未打开工作区时抛出中文错误。
	 *
	 * @param scope 作用域标识
	 * @returns 命令目录绝对路径
	 */
	private dirFor(scope: CommandScope): string {
		if (scope === 'project') {
			if (!this.dirs.projectDir) {
				throw new Error('未打开工作区，无法管理项目 Command');
			}
			return this.dirs.projectDir;
		}
		return this.dirs.globalDir;
	}

	/**
	 * 计算命令文件路径并校验其落在作用域目录内（名称经正则校验后理论安全，此处二次兜底）。
	 *
	 * @param scope 作用域标识
	 * @param name 命令名
	 * @returns 命令文件绝对路径
	 */
	private filePathFor(scope: CommandScope, name: string): string {
		const dir = path.resolve(this.dirFor(scope));
		const filePath = path.resolve(dir, `${name}.md`);
		const relative = path.relative(dir, filePath);
		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			throw new Error(`非法命令路径，已拒绝 scope=${scope} name=${name}`);
		}
		return filePath;
	}

	/**
	 * 序列化 Command 内容为 Markdown 文件文本（可选 description frontmatter + 非空正文）。
	 *
	 * @param input 命令内容
	 * @returns 文件文本
	 */
	private serialize(input: CommandInput): string {
		const body = input.body.trim();
		const frontmatter = input.description ? `---\ndescription: ${input.description}\n---\n\n` : '';
		return `${frontmatter}${body}\n`;
	}

	/**
	 * 校验创建输入：名称合法、正文非空；校验失败抛出中文错误。
	 *
	 * @param input 创建输入
	 * @param name 命令名
	 */
	private validateCreate(input: CommandInput, name: string): void {
		if (!isValidCommandName(name)) {
			throw new Error('命令名不合法：以小写字母或数字开头，仅允许小写字母、数字、- 和 _');
		}
		if (!input.body.trim()) {
			throw new Error('命令正文不能为空');
		}
	}

	/**
	 * 重新扫描双作用域并重建注册表，返回最新快照。
	 *
	 * @returns 最新双作用域命令快照
	 */
	private async loadAndApply(): Promise<CommandSnapshot> {
		const snapshot = await loadCommandScopesFromDirs(this.dirs);
		this.registry.reload(snapshot);
		return snapshot;
	}

	/**
	 * 将操作排入串行链：并发调用按入队顺序执行，任一失败不污染后续任务。
	 *
	 * @param task 待执行的重载/变更任务
	 * @returns 任务结果
	 */
	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.chain.then(task, task);
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * 返回当前注册表对应的双作用域快照（无需重载）。
	 *
	 * @returns 当前命令快照
	 */
	getSnapshot(): CommandSnapshot {
		return {
			global: this.registry.getGlobalSnapshot(),
			project: this.registry.getProjectSnapshot(),
		};
	}

	/**
	 * 手动刷新：重新扫描双作用域并更新注册表（外部文件变更后调用）。
	 *
	 * @returns 最新双作用域命令快照
	 */
	refresh(): Promise<CommandSnapshot> {
		logger.log(`[CommandStore] 手动刷新命令 global=${this.dirs.globalDir} project=${this.dirs.projectDir ?? '无'}`);
		return this.enqueue(() => this.loadAndApply());
	}

	/**
	 * 创建 Command：目录不存在时按需创建，成功后重载注册表。
	 *
	 * @param scope 目标作用域（global/project）
	 * @param input 创建输入（name/description/body）
	 * @returns 最新双作用域命令快照
	 */
	create(scope: CommandScope, input: CommandInput): Promise<CommandSnapshot> {
		const name = input.name ?? '';
		return this.enqueue(async () => {
			this.validateCreate(input, name);
			const dir = this.dirFor(scope);
			const filePath = this.filePathFor(scope, name);
			logger.log(`[CommandStore] 创建 Command scope=${scope} 目录=${dir} name=${name}`);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(filePath, this.serialize(input), 'utf8');
			return this.loadAndApply();
		});
	}

	/**
	 * 编辑已有 Command：仅更新该作用域中的目标文件（文件名即身份，不支持改名），成功后重载。
	 *
	 * @param scope 目标作用域
	 * @param name 现有命令名（文件名）
	 * @param input 更新内容（description/body；name 忽略）
	 * @returns 最新双作用域命令快照
	 */
	update(scope: CommandScope, name: string, input: CommandInput): Promise<CommandSnapshot> {
		return this.enqueue(async () => {
			if (!isValidCommandName(name)) {
				throw new Error('命令名不合法：以小写字母或数字开头，仅允许小写字母、数字、- 和 _');
			}
			if (!input.body.trim()) {
				throw new Error('命令正文不能为空');
			}
			const filePath = this.filePathFor(scope, name);
			logger.log(`[CommandStore] 编辑 Command scope=${scope} 目录=${this.dirFor(scope)} name=${name}`);
			await fs.writeFile(filePath, this.serialize(input), 'utf8');
			return this.loadAndApply();
		});
	}

	/**
	 * 删除 Command：仅删除对应作用域中的 Markdown 文件，成功后重载。
	 *
	 * @param scope 目标作用域
	 * @param name 待删除命令名（文件名）
	 * @returns 最新双作用域命令快照
	 */
	delete(scope: CommandScope, name: string): Promise<CommandSnapshot> {
		return this.enqueue(async () => {
			if (!isValidCommandName(name)) {
				throw new Error('命令名不合法：以小写字母或数字开头，仅允许小写字母、数字、- 和 _');
			}
			const filePath = this.filePathFor(scope, name);
			logger.log(`[CommandStore] 删除 Command scope=${scope} 目录=${this.dirFor(scope)} name=${name}`);
			try {
				await fs.unlink(filePath);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
					throw new Error(`命令不存在：/${name}`);
				}
				throw err;
			}
			return this.loadAndApply();
		});
	}
}
