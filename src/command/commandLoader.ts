/**
 * Command 加载器 - 从固定目录扫描 Markdown 文件，解析为作用域快照。
 *
 * 全局命令目录：`os.homedir()/.yunForce/command`；
 * 项目命令目录：第一个工作区根目录下的 `.yunForce/command`（无工作区时不加载）。
 * 目录不存在等同于空作用域，单个无效文件不得阻止其他有效 Command 加载。
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Command, CommandScope, CommandScopeSnapshot } from './types';
import { isValidCommandName, parseCommandContent } from './commandParser';
import * as logger from '../logger';

/** 命令目录固定相对路径（全局：主目录；项目：第一个工作区根）。 */
const COMMAND_DIR_NAME = 'command';

/** 解析后的命令目录集合。 */
export interface CommandDirectories {
	/** 全局命令目录绝对路径 */
	readonly globalDir: string;
	/** 项目命令目录绝对路径；未打开工作区时缺省 */
	readonly projectDir?: string;
}

/**
 * 解析固定 Command 目录：全局 = `~/.yunForce/command`；项目 = 第一个工作区根 `.yunForce/command`。
 *
 * @param workspaceRoots 当前工作区根目录列表（空表示未打开工作区）
 * @returns 全局与可选的项目命令目录
 */
export function resolveCommandDirectories(workspaceRoots: readonly string[]): CommandDirectories {
	const globalDir = path.join(os.homedir(), '.yunForce', COMMAND_DIR_NAME);
	const projectDir = workspaceRoots.length > 0
		? path.join(workspaceRoots[0], '.yunForce', COMMAND_DIR_NAME)
		: undefined;
	return { globalDir, projectDir };
}

/**
 * 从指定目录加载单个作用域的命令快照。
 *
 * 目录不存在或不可读时视为空快照；仅处理 `.md` 文件，文件名非法、
 * 正文为空或 frontmatter 格式无效的文件跳过并记录不含正文的中文日志。
 *
 * @param scope 作用域标识
 * @param directory 命令目录绝对路径
 * @returns 该作用域的命令快照（命令按名称排序）
 */
export async function loadCommandScope(scope: CommandScope, directory: string): Promise<CommandScopeSnapshot> {
	let entries: string[];
	try {
		entries = await fs.readdir(directory);
	} catch {
		logger.log(`[CommandLoader] 命令目录不存在或不可读，视为空作用域 scope=${scope} 目录=${directory}`);
		return { scope, directory, commands: [] };
	}

	const commands: Command[] = [];
	for (const entry of entries) {
		if (!entry.endsWith('.md')) {
			continue;
		}
		const name = entry.slice(0, -'.md'.length);
		if (!isValidCommandName(name)) {
			logger.log(`[CommandLoader] 跳过非法命令名 scope=${scope} 目录=${directory} name=${name}`);
			continue;
		}
		const filePath = path.join(directory, entry);
		let raw: string;
		try {
			raw = await fs.readFile(filePath, 'utf8');
		} catch (err) {
			logger.log(`[CommandLoader] 读取命令文件失败 scope=${scope} 目录=${directory} name=${name} error=${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		const parsed = parseCommandContent(name, raw);
		if (!parsed) {
			// 解析器内部已记录不含正文的跳过日志
			continue;
		}
		logger.log(`[CommandLoader] 加载 Command scope=${scope} 目录=${directory} name=${name}`);
		commands.push({ name, ...(parsed.description ? { description: parsed.description } : {}), body: parsed.body, scope, sourcePath: filePath });
	}

	commands.sort((a, b) => a.name.localeCompare(b.name));
	logger.log(`[CommandLoader] 作用域加载完成 scope=${scope} 目录=${directory} 数量=${commands.length}`);
	return { scope, directory, commands };
}

/**
 * 加载双作用域命令快照（项目作用域在未打开工作区时为 null）。
 *
 * @param dirs 解析后的命令目录集合
 * @returns 全局与项目命令快照
 */
export async function loadCommandScopesFromDirs(dirs: CommandDirectories): Promise<{
	global: CommandScopeSnapshot;
	project: CommandScopeSnapshot | null;
}> {
	const global = await loadCommandScope('global', dirs.globalDir);
	const project = dirs.projectDir
		? await loadCommandScope('project', dirs.projectDir)
		: null;
	return { global, project };
}
