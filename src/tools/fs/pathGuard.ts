/**
 * 路径安全守卫 - 所有文件工具的安全前提（CRITICAL）。
 *
 * 职责：
 * - 工作区根解析（来自 vscode.workspace.workspaceFolders）
 * - 路径规范化（POSIX/Windows 统一）
 * - `..` 越界检测
 * - 符号链接解析与越界检测（realpath 后再次校验）
 * - 敏感文件检测（.env / .git / credentials / 私钥等）
 *
 * 设计：纯函数核心 `resolveWithinRoots` 接受 roots 与可注入的 realpath，
 * 使安全逻辑无需真实文件系统即可单测；`getWorkspaceRoots` 为 VSCode 适配层。
 */
import * as path from 'path';
import { promises as fs } from 'fs';
import { PathGuardError } from '../../core/errors';

// VSCode 延迟加载：纯函数（resolveWithinRoots / isSensitivePath）不依赖 vscode，
// 可在无 VSCode 环境下直接用 mocha 单测。仅工作区适配函数在运行时 require vscode。
type VsCodeApi = typeof import('vscode');
function vscodeApi(): VsCodeApi {
	return require('vscode');
}

/** 路径守卫选项。 */
export interface PathGuardOptions {
	/** 是否跟随符号链接（默认 true）。 */
	readonly followSymlinks?: boolean;
	/** 可注入的 realpath 实现，默认 fs.realpath（测试用）。 */
	readonly realpath?: (p: string) => Promise<string>;
}

/** 解析后的路径信息。 */
export interface ResolvedPath {
	/** 绝对、规范化后的路径（followSymlinks 时为 realpath）。 */
	readonly fsPath: string;
	/** 相对于匹配工作区根的相对路径。 */
	readonly relativePath: string;
	/** 匹配的工作区根。 */
	readonly root: string;
	/** 是否为敏感文件/目录。 */
	readonly sensitive: boolean;
}

/** 敏感文件/目录匹配模式（路径分隔符统一为 / 后匹配）。 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
	/(^|\/)\.env(\..*)?$/i,
	/(^|\/)\.git(\/|$)/i,
	/(^|\/)credentials\.json$/i,
	/(^|\/)\.npmrc$/i,
	/(^|\/)\.ssh\//i,
	/(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/i,
	/(^|\/)\.aws\/credentials$/i,
	/(^|\/)\.htpasswd$/i,
];

/** 判断路径是否敏感。 */
export function isSensitivePath(inputPath: string): boolean {
	const normalized = inputPath.replace(/\\/g, '/');
	return SENSITIVE_PATTERNS.some((re) => re.test(normalized));
}

/** 判断路径 p 是否被某个 root 包含（词法层面，无 fs）。 */
function isContainedBy(p: string, roots: string[]): boolean {
	const norm = path.normalize(p);
	return roots.some((root) => {
		const normRoot = path.normalize(root);
		return norm === normRoot || norm.startsWith(normRoot + path.sep);
	});
}

/** 词法解析：规范化并找到包含该路径的工作区根，越界抛错。 */
function lexicalResolve(
	inputPath: string,
	roots: string[]
): { resolved: string; root: string } {
	const normRoots = roots.map((r) => path.normalize(path.resolve(r)));
	const isAbsolute = path.isAbsolute(inputPath);
	for (const root of normRoots) {
		const candidate = path.normalize(isAbsolute ? inputPath : path.resolve(root, inputPath));
		if (isContainedBy(candidate, [root])) {
			return { resolved: candidate, root };
		}
	}
	throw new PathGuardError(`路径越界: ${inputPath}`, 'traversal');
}

/**
 * 解析输入路径并校验其位于工作区根内。
 * @param inputPath 用户/工具请求的路径（相对或绝对）
 * @param roots 工作区根列表（绝对路径）
 * @param options 选项（followSymlinks / realpath 注入）
 * @throws PathGuardError 无工作区 / 越界 / 符号链接越界
 */
export async function resolveWithinRoots(
	inputPath: string,
	roots: string[],
	options?: PathGuardOptions
): Promise<ResolvedPath> {
	if (roots.length === 0) {
		throw new PathGuardError('未打开工作区', 'no_workspace');
	}

	const { resolved, root } = lexicalResolve(inputPath, roots);

	let finalPath = resolved;
	const followSymlinks = options?.followSymlinks ?? true;
	if (followSymlinks) {
		const realpath = options?.realpath ?? ((p: string) => fs.realpath(p));
		try {
			const real = await realpath(resolved);
			// realpath roots（失败则回退原值），再次校验 real 目标在根内
			const realRoots = await Promise.all(
				roots.map(async (r) => {
					try {
						return await realpath(r);
					} catch {
						return r;
					}
				})
			);
			if (!isContainedBy(real, realRoots)) {
				throw new PathGuardError(`符号链接指向工作区外: ${resolved}`, 'symlink_escape');
			}
			finalPath = real;
		} catch (err) {
			// PathGuardError 直接抛出
			if (err instanceof PathGuardError) {
				throw err;
			}
			// realpath 失败通常意味着路径不存在 -> 保留词法解析结果，
			// 由调用方（如 read_file）处理 ENOENT。
		}
	}

	return {
		fsPath: finalPath,
		relativePath: path.relative(root, finalPath),
		root,
		sensitive: isSensitivePath(resolved),
	};
}

/** 从 VSCode 工作区获取根路径列表。 */
export function getWorkspaceRoots(): string[] {
	const folders = vscodeApi().workspace.workspaceFolders ?? [];
	return folders.map((f) => f.uri.fsPath);
}

/** 便捷方法：使用当前 VSCode 工作区根解析路径。 */
export async function resolveFromWorkspace(
	inputPath: string,
	options?: PathGuardOptions
): Promise<ResolvedPath> {
	return resolveWithinRoots(inputPath, getWorkspaceRoots(), options);
}
