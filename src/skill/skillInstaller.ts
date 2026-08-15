/**
 * 项目 Claude Skill 安装服务 - 将有效 Skill 内容写入 `.claude/skills/<skill-name>/SKILL.md`。
 *
 * 职责：
 * - 校验 Skill 名称（拒绝路径分隔符、`..` 与不规范字符，防止路径穿越）
 * - 经路径守卫解析安装目标，拒绝无工作区场景
 * - 写入文件并返回结果（成功路径 / 明确失败原因）
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { resolveWithinRoots } from '../tools/fs/pathGuard';
import { PathGuardError } from '../core/errors';
import { parseFrontmatter } from './skillLoader';
import * as logger from '../logger';

/** Skill 名称合法格式：字母/数字/-/_，长度 1-64（天然排除路径分隔符与 `..`）。 */
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** ZIP 文件大小上限，避免读取异常大的压缩包。 */
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
/** ZIP 内文件条目数上限。 */
const MAX_ARCHIVE_ENTRIES = 200;
/** ZIP 解压后总大小上限，防止压缩炸弹。 */
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;

/** Skill 安装结果。 */
export type SkillInstallResult =
	| { readonly ok: true; readonly filePath: string; readonly name?: string }
	| { readonly ok: false; readonly reason: string };

/** 已校验的 ZIP Skill 文件。 */
interface ArchiveSkillFile {
	/** 相对 Skill 根目录的安全路径。 */
	readonly relativePath: string;
	/** 文件内容。 */
	readonly content: Buffer;
}

/**
 * 校验 Skill 名称是否安全，返回可显示的错误消息；合法返回 null。
 *
 * @param name 待校验的 Skill 名称
 * @returns 校验错误消息（可显示给用户），合法时为 null
 */
export function validateSkillName(name: string): string | null {
	if (!name || !name.trim()) {
		return 'Skill 名称不能为空';
	}
	if (!SAFE_NAME_RE.test(name)) {
		return 'Skill 名称只能包含字母、数字、- 与 _，且长度不超过 64';
	}
	return null;
}

/**
 * 安装项目 Skill：将内容写入第一个工作区根的 `.claude/skills/<name>/SKILL.md`。
 * 无工作区、名称不安全或路径越界时不写任何文件并返回明确原因。
 *
 * @param name 经过校验的 Skill 名称
 * @param content Skill 内容（Markdown 正文）
 * @param workspaceRoots 工作区根目录列表（取第一个作为安装目标）
 * @returns 成功时含写入路径；失败时含可显示的原因
 */
export async function installProjectSkill(
	name: string,
	content: string,
	workspaceRoots: string[]
): Promise<SkillInstallResult> {
	if (workspaceRoots.length === 0) {
		logger.error(`[SkillInstaller] 拒绝安装 Skill name=${name}：未打开工作区`);
		return { ok: false, reason: '未打开工作区，无法安装项目 Skill' };
	}

	const nameError = validateSkillName(name);
	if (nameError) {
		logger.error(`[SkillInstaller] 拒绝不安全 Skill 名称 name=${name}: ${nameError}`);
		return { ok: false, reason: nameError };
	}

	if (!content || !content.trim()) {
		logger.error(`[SkillInstaller] 拒绝安装 Skill name=${name}：内容为空`);
		return { ok: false, reason: 'Skill 内容不能为空' };
	}

	// 安装目标固定为第一个工作区根下的 .claude/skills/<name>/SKILL.md，经路径守卫校验
	const target = path.join('.claude', 'skills', name, 'SKILL.md');
	let resolved;
	try {
		resolved = await resolveWithinRoots(target, workspaceRoots, { followSymlinks: true });
	} catch (err) {
		if (err instanceof PathGuardError) {
			logger.error(`[SkillInstaller] 路径守卫拒绝 target=${target}: ${err.message}`);
			return { ok: false, reason: `安装路径不被允许: ${err.message}` };
		}
		throw err;
	}

	try {
		await fs.mkdir(path.dirname(resolved.fsPath), { recursive: true });
		await fs.writeFile(resolved.fsPath, content, 'utf8');
	} catch (err) {
		logger.error(`[SkillInstaller] 写入失败 name=${name} path=${resolved.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
		return { ok: false, reason: `写入 Skill 失败: ${err instanceof Error ? err.message : String(err)}` };
	}

	logger.log(`[SkillInstaller] Skill 安装完成 name=${name} path=${resolved.fsPath}`);
	return { ok: true, filePath: resolved.fsPath };
}

/**
 * 安装 Skill ZIP：校验压缩包与 SKILL.md 协议后，将 Skill 及其资源写入项目目录。
 *
 * @param archivePath 用户通过原生文件选择器选择的 ZIP 路径
 * @param workspaceRoots 工作区根目录列表
 * @returns 安装结果；失败时不写入目标目录
 */
export async function installSkillArchive(
	archivePath: string,
	workspaceRoots: string[]
): Promise<SkillInstallResult> {
	if (workspaceRoots.length === 0) {
		logger.error(`[SkillInstaller] 拒绝 ZIP 安装 archive=${archivePath}：未打开工作区`);
		return { ok: false, reason: '未打开工作区，无法安装项目 Skill' };
	}
	if (path.extname(archivePath).toLowerCase() !== '.zip') {
		return { ok: false, reason: '只能上传 .zip 格式的 Skill 包' };
	}
	try {
		const stat = await fs.stat(archivePath);
		if (!stat.isFile()) {
			return { ok: false, reason: '请选择一个 ZIP 文件' };
		}
		if (stat.size > MAX_ARCHIVE_BYTES) {
			return { ok: false, reason: 'ZIP 文件超过 20 MB 上限' };
		}
	} catch (err) {
		logger.error(`[SkillInstaller] 读取 ZIP 文件失败 archive=${archivePath}: ${err instanceof Error ? err.message : String(err)}`);
		return { ok: false, reason: '无法读取所选 ZIP 文件' };
	}

	let archive: AdmZip;
	try {
		archive = new AdmZip(archivePath);
	} catch (err) {
		logger.error(`[SkillInstaller] 解析 ZIP 失败 archive=${archivePath}: ${err instanceof Error ? err.message : String(err)}`);
		return { ok: false, reason: 'ZIP 文件无法解析或已损坏' };
	}
	const entries = archive.getEntries().filter((entry) => !entry.isDirectory);
	if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
		return { ok: false, reason: `ZIP 内文件数量必须在 1-${MAX_ARCHIVE_ENTRIES} 之间` };
	}
	let totalUncompressedBytes = 0;
	const normalizedEntries: { readonly entry: AdmZip.IZipEntry; readonly entryName: string }[] = [];
	for (const entry of entries) {
		const entryName = entry.entryName.replace(/\\/g, '/');
		if (!isSafeArchivePath(entryName)) {
			logger.error(`[SkillInstaller] 拒绝不安全 ZIP 路径 archive=${archivePath} entry=${entry.entryName}`);
			return { ok: false, reason: 'ZIP 包含不安全路径，已拒绝安装' };
		}
		totalUncompressedBytes += entry.header.size;
		if (totalUncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
			return { ok: false, reason: 'ZIP 解压后内容超过 10 MB 上限' };
		}
		normalizedEntries.push({ entry, entryName });
	}

	const skillEntries = normalizedEntries.filter(({ entryName }) => entryName === 'SKILL.md' || /^[^/]+\/SKILL\.md$/.test(entryName));
	if (skillEntries.length !== 1) {
		return { ok: false, reason: 'ZIP 必须且只能包含一个根目录或一层目录内的 SKILL.md' };
	}
	const skillEntry = skillEntries[0];
	const skillRoot = skillEntry.entryName === 'SKILL.md' ? '' : skillEntry.entryName.slice(0, skillEntry.entryName.lastIndexOf('/') + 1);
	const skillContent = skillEntry.entry.getData().toString('utf8');
	const { frontmatter, body } = parseFrontmatter(skillContent);
	if (!frontmatter || !body.trim()) {
		return { ok: false, reason: 'SKILL.md 必须包含 name、description frontmatter 和非空正文' };
	}
	const nameError = validateSkillName(frontmatter.name);
	if (nameError) {
		return { ok: false, reason: `SKILL.md 的 name 不合法：${nameError}` };
	}
	const files: ArchiveSkillFile[] = [];
	for (const { entry, entryName } of normalizedEntries) {
		if (skillRoot && !entryName.startsWith(skillRoot)) {
			return { ok: false, reason: 'ZIP 顶层目录只能包含一个 Skill 包' };
		}
		const relativePath = skillRoot ? entryName.slice(skillRoot.length) : entryName;
		if (!relativePath || !isSafeArchivePath(relativePath)) {
			return { ok: false, reason: 'ZIP 包含不安全路径，已拒绝安装' };
		}
		files.push({ relativePath, content: entry.getData() });
	}

	const targetRoot = path.join('.claude', 'skills', frontmatter.name);
	let resolvedRoot;
	try {
		resolvedRoot = await resolveWithinRoots(targetRoot, workspaceRoots, { followSymlinks: true });
	} catch (err) {
		if (err instanceof PathGuardError) {
			logger.error(`[SkillInstaller] ZIP 目标路径被拒绝 target=${targetRoot}: ${err.message}`);
			return { ok: false, reason: `安装路径不被允许: ${err.message}` };
		}
		throw err;
	}
	try {
		for (const file of files) {
			const target = path.join(resolvedRoot.fsPath, file.relativePath);
			if (!isWithinDirectory(target, resolvedRoot.fsPath)) {
				return { ok: false, reason: 'ZIP 包含越界路径，已拒绝安装' };
			}
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, file.content);
		}
	} catch (err) {
		logger.error(`[SkillInstaller] ZIP Skill 写入失败 name=${frontmatter.name}: ${err instanceof Error ? err.message : String(err)}`);
		return { ok: false, reason: `写入 Skill 失败: ${err instanceof Error ? err.message : String(err)}` };
	}
	const skillPath = path.join(resolvedRoot.fsPath, 'SKILL.md');
	logger.log(`[SkillInstaller] ZIP Skill 安装完成 name=${frontmatter.name} files=${files.length} path=${skillPath}`);
	return { ok: true, name: frontmatter.name, filePath: skillPath };
}

/**
 * 判断 ZIP 内相对路径是否安全。
 *
 * @param filePath ZIP 条目路径
 * @returns 是否不含绝对路径、空段与路径穿越
 */
function isSafeArchivePath(filePath: string): boolean {
	return Boolean(filePath) && !path.posix.isAbsolute(filePath) && !filePath.split('/').some((part) => !part || part === '.' || part === '..') && !filePath.includes('\0');
}

/**
 * 判断目标路径仍位于预期目录内。
 *
 * @param targetPath 待写入路径
 * @param rootPath Skill 根目录
 * @returns 是否位于根目录内
 */
function isWithinDirectory(targetPath: string, rootPath: string): boolean {
	const relative = path.relative(rootPath, targetPath);
	return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
