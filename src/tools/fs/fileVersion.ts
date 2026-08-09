import { promises as fs } from 'fs';
import * as crypto from 'crypto';
import * as logger from '../../logger';

/** 轻量文件版本标识，用于在写入前发现“读后被用户修改”的冲突。 */
export async function getFileVersion(fsPath: string): Promise<string | undefined> {
	try {
		return getFileVersionFromContent(await fs.readFile(fsPath, 'utf8'));
	} catch {
		logger.error(`[fs.file_version] 读取版本失败 - path=${fsPath}`);
		return undefined;
	}
}

/** 根据已读取的精确文本计算版本，保证预览与版本校验使用同一份内容。 */
export function getFileVersionFromContent(content: string): string {
	return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function hasVersionConflict(fsPath: string, expected: unknown): Promise<boolean> {
	if (expected === undefined) {
		return false;
	}
	return typeof expected !== 'string' || (await getFileVersion(fsPath)) !== expected;
}
