/**
 * Skill 加载器 - 从目录扫描 Markdown 文件，解析 frontmatter + 正文。
 *
 * 零依赖实现：用简单字符串分割解析 YAML frontmatter，
 * 仅支持 name/description/slash 三个扁平字段。
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import type { Skill, SkillFrontmatter } from './types';
import * as logger from '../logger';

/**
 * 解析 Markdown 文件的 frontmatter。
 *
 * 标准格式：
 * ---
 * name: my-skill
 * description: 描述何时使用此 skill
 * slash: true
 * ---
 * Markdown 正文...
 *
 * @returns frontmatter 为 null 表示文件无 frontmatter
 */
export function parseFrontmatter(raw: string): {
	frontmatter: SkillFrontmatter | null;
	body: string;
} {
	const lines = raw.split('\n');

	// 首行必须是 ---
	if (lines.length === 0 || lines[0].trim() !== '---') {
		return { frontmatter: null, body: raw };
	}

	// 找到闭合 ---
	let endIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === '---') {
			endIndex = i;
			break;
		}
	}

	if (endIndex === -1) {
		return { frontmatter: null, body: raw };
	}

	const yamlLines = lines.slice(1, endIndex);
	const body = lines.slice(endIndex + 1).join('\n').trim();

	// 解析 key: value
	const fields: Record<string, string> = {};
	for (const line of yamlLines) {
		const colonIdx = line.indexOf(':');
		if (colonIdx === -1) {
			continue;
		}
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();
		if (key) {
			fields[key] = value;
		}
	}

	// 必须有 name 和 description
	if (!fields.name || !fields.description) {
		return { frontmatter: null, body };
	}

	const frontmatter: SkillFrontmatter = {
		name: fields.name,
		description: fields.description,
		slash: fields.slash === 'true',
		type: fields.type === 'agent' ? 'agent' : fields.type === 'skill' ? 'skill' : undefined,
	};

	return { frontmatter, body };
}

/**
 * 从目录加载所有 Skill。
 *
 * 支持两种结构：
 * 1. 扁平 `*.md` 文件（既有行为，如 `.vscode/skills/plan.md`）；
 * 2. 标准嵌套 `<目录>/<skill-name>/SKILL.md`（Anthropic Agent Skills / Trae 格式，一层）。
 *
 * 无 frontmatter 或缺少必填字段的文件会被跳过。
 * 目录不存在时返回空数组，不抛异常。
 */
export async function loadSkillsFromDirectory(dirPath: string): Promise<Skill[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(dirPath);
	} catch {
		// 目录不存在或不可读
		return [];
	}

	const skills: Skill[] = [];

	/**
	 * 读取并解析单个 Skill 文件。
	 *
	 * @param filePath Skill 文件绝对路径
	 * @param logReadFailure 读取失败时是否记录日志（扁平文件应记录；嵌套目录无 SKILL.md 属常态不记录）
	 * @returns 解析成功的 Skill，文件不存在/不可读或无合法 frontmatter 时为 null
	 */
	const loadSkillFile = async (filePath: string, logReadFailure: boolean): Promise<Skill | null> => {
		let raw: string;
		try {
			raw = await fs.readFile(filePath, 'utf8');
		} catch {
			if (logReadFailure) {
				logger.log(`[SkillLoader] 读取文件失败: ${filePath}`);
			}
			return null;
		}

		const { frontmatter, body } = parseFrontmatter(raw);
		if (!frontmatter) {
			logger.log(`[SkillLoader] 跳过无 frontmatter 的文件: ${filePath}`);
			return null;
		}

		logger.log(`[SkillLoader] 加载 Skill 文件 path=${filePath} name=${frontmatter.name}`);
		return {
			name: frontmatter.name,
			description: frontmatter.description,
			slash: frontmatter.slash,
			type: frontmatter.type,
			content: body,
			sourcePath: filePath,
		};
	};

	for (const entry of entries) {
		if (entry.endsWith('.md')) {
			// 扁平 *.md（既有行为）
			const skill = await loadSkillFile(path.join(dirPath, entry), true);
			if (skill) {
				skills.push(skill);
			}
			continue;
		}
		// 标准嵌套结构：<目录>/<skill-name>/SKILL.md
		const nested = await loadSkillFile(path.join(dirPath, entry, 'SKILL.md'), false);
		if (nested) {
			skills.push(nested);
		}
	}

	logger.log(`[SkillLoader] 加载完成 数量=${skills.length} 目录=${dirPath}`);
	return skills;
}
