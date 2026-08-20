/**
 * Command 解析器 - 命令名校验与 Markdown 文件内容解析。
 *
 * 命令名由文件名确定（不含 `.md` 后缀），必须以小写字母或数字开头，
 * 后续仅允许小写字母、数字、`-`、`_`。文件可包含扁平 YAML frontmatter
 * 提供可选的单行 `description`，正文必须非空；frontmatter 格式无效视为文件无效。
 */
import * as logger from '../logger';

/** 合法命令名的正则：小写字母或数字开头，后续仅小写字母、数字、`-`、`_`。 */
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * 校验命令名是否合法（长度 > 0 且匹配名称模式）。
 *
 * @param name 待校验的命令名
 * @returns 合法返回 true，否则返回 false
 */
export function isValidCommandName(name: string): boolean {
	return name.length > 0 && COMMAND_NAME_PATTERN.test(name);
}

/**
 * 解析命令 Markdown 内容，提取可选描述与非空正文。
 *
 * 规则：
 * - 无 frontmatter：正文即全文（trim 后必须非空）。
 * - 首行为 `---`：按 frontmatter 解析，未闭合视为格式无效返回 null；
 *   仅读取扁平 `description: <value>`，其余键忽略。
 * - 正文 trim 后为空视为无效返回 null。
 *
 * @param name 命令名（由文件名确定，用于日志定位）
 * @param raw 文件原文
 * @returns 解析成功返回 { description?, body }；名称或内容无效返回 null
 */
export function parseCommandContent(name: string, raw: string): { description?: string; body: string } | null {
	const lines = raw.split('\n');

	// 首行不是 ---：无 frontmatter，全文即正文
	if (lines.length === 0 || lines[0].trim() !== '---') {
		const body = raw.trim();
		if (!body) {
			logger.log(`[CommandParser] 跳过正文为空的 Command name=${name}`);
			return null;
		}
		return { body };
	}

	// 首行是 ---：寻找闭合标记，未闭合视为格式无效
	let endIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === '---') {
			endIndex = i;
			break;
		}
	}
	if (endIndex === -1) {
		logger.log(`[CommandParser] 跳过 frontmatter 未闭合的 Command name=${name}`);
		return null;
	}

	// 解析扁平 description 字段
	let description: string | undefined;
	for (const line of lines.slice(1, endIndex)) {
		const colonIdx = line.indexOf(':');
		if (colonIdx === -1) {
			continue;
		}
		const key = line.slice(0, colonIdx).trim();
		if (key === 'description') {
			description = line.slice(colonIdx + 1).trim();
		}
	}

	const body = lines.slice(endIndex + 1).join('\n').trim();
	if (!body) {
		logger.log(`[CommandParser] 跳过正文为空的 Command name=${name}`);
		return null;
	}
	return { ...(description ? { description } : {}), body };
}
