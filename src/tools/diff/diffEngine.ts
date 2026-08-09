/**
 * Diff 引擎 - unified diff 解析、patch 应用、diff 生成。
 * 基于 `diff` npm 包封装，提供类型安全接口与冲突检测。
 * code.edit 的底层依赖；纯函数，无需 vscode/文件系统即可单测。
 */
import { parsePatch, applyPatch, createPatch } from 'diff';
import * as logger from '../../logger';

/** 解析后的单个 hunk。 */
export interface ParsedHunk {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	readonly lines: readonly string[];
}

/** 解析后的单个文件 patch。 */
export interface ParsedPatch {
	readonly index?: string;
	readonly oldFileName?: string;
	readonly newFileName?: string;
	readonly hunks: readonly ParsedHunk[];
}

/** patch 应用结果。ok=false 时 result 为原内容，conflict 含原因。 */
export interface ApplyResult {
	readonly ok: boolean;
	readonly result: string;
	readonly conflict?: string;
}

/** 应用时的匹配选项。 */
export interface ApplyOptions {
	/** 上下文行容忍度（fuzz），默认 2。 */
	readonly fuzzFactor?: number;
}

/** 默认上下文行数（生成 diff 时）。 */
const DEFAULT_CONTEXT = 3;

/** 解析 unified diff 字符串为结构化 patch。非法/空输入抛错。 */
export function parseDiff(patchStr: string): ParsedPatch[] {
	const parsed = parsePatch(patchStr);
	const hasHunks = parsed.some((p) => p.hunks && p.hunks.length > 0);
	if (!parsed || parsed.length === 0 || !hasHunks) {
		throw new Error('无法解析 unified diff：输入为空或格式无效');
	}
	return parsed as unknown as ParsedPatch[];
}

/** 应用 patch 到源内容。上下文不匹配则返回冲突（不修改原内容）。 */
export function applyDiff(
	content: string,
	patch: string | ParsedPatch | ParsedPatch[],
	options?: ApplyOptions
): ApplyResult {
	const patches =
		typeof patch === 'string'
			? parseDiff(patch)
			: Array.isArray(patch)
				? [patch]
				: [patch];
	const fuzzFactor = options?.fuzzFactor ?? 2;
	const result = applyPatch(content, patches as unknown as Parameters<typeof applyPatch>[1], {
		fuzzFactor,
	});
	if (result === false) {
		return {
			ok: false,
			result: content,
			conflict: 'patch 上下文不匹配，无法应用（文件可能已被修改）',
		};
	}
	return { ok: true, result };
}

/** 生成文件级 unified diff。返回值可被 parseDiff 解析。 */
export function createDiff(
	original: string,
	modified: string,
	filename = 'file'
): string {
	logger.log(`[DiffEngine] 开始生成 diff - filename=${filename}, originalLength=${original.length}, modifiedLength=${modified.length}`);
	const diffStr = createPatch(filename, original, modified, '', '', {
		context: DEFAULT_CONTEXT,
	});
	const addedLines = (diffStr.match(/^\+[^+]/gm) ?? []).length;
	const removedLines = (diffStr.match(/^-[^-]/gm) ?? []).length;
	logger.log(`[DiffEngine] 生成完成 - filename=${filename}, fileCount=1, addedLines=${addedLines}, removedLines=${removedLines}`);
	return diffStr;
}
