import { promises as fs } from 'fs';

/** 轻量文件版本标识，用于在写入前发现“读后被用户修改”的冲突。 */
export async function getFileVersion(fsPath: string): Promise<string | undefined> {
	try {
		const stat = await fs.stat(fsPath);
		return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
	} catch {
		return undefined;
	}
}

export async function hasVersionConflict(fsPath: string, expected: unknown): Promise<boolean> {
	if (expected === undefined) {
		return false;
	}
	return typeof expected !== 'string' || (await getFileVersion(fsPath)) !== expected;
}
