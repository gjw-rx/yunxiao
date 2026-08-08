/**
 * code.find_references - 查找符号的所有引用（read 权限，本地执行）。
 *
 * 经 VSCode Language API（executeReferenceProvider）查找给定位置符号的全部引用，
 * 返回 { file, line, column } 列表（1-based）。结果超 50 条时按文件分组截断（每文件最多 10 条）。
 * vscode 访问可注入，便于无 vscode 单测。
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import {
	BaseTool,
	requireStringArg,
	type ToolContext,
	type ToolExecutionResult,
} from '../baseTool';
import { resolveWithinRoots } from '../fs/pathGuard';
import { PathGuardError, ToolValidationError } from '../../core/errors';
import type { ToolSchema } from '../../core/types';

/** vscode 能力的最小 shim（便于注入测试）。 */
export interface VsCodeRefShim {
	executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
	fileUri(fsPath: string): unknown;
	position(line: number, character: number): unknown;
}

/** VSCode Location 最小形状（executeReferenceProvider 返回值）。 */
interface VsCodeLocation {
	uri: { fsPath: string };
	range: { start: { line: number; character: number } };
}

/** 引用条目（输出）。 */
interface ReferenceEntry {
	readonly file: string;
	readonly line: number;
	readonly column: number;
}

type VsCodeApi = typeof import('vscode');
function vscodeApi(): VsCodeApi {
	return require('vscode');
}

const defaultShim: VsCodeRefShim = {
	executeCommand(command, ...args) {
		return Promise.resolve(vscodeApi().commands.executeCommand(command, ...args));
	},
	fileUri(fsPath) {
		return vscodeApi().Uri.file(fsPath);
	},
	position(line, character) {
		return new (vscodeApi().Position)(line, character);
	},
};

export class FindReferencesTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'code.find_references',
		description: '查找工作区内某符号位置的全部引用，返回文件/行/列列表（1-based）。',
		parameters: {
			type: 'object',
			properties: {
				file: { type: 'string', description: '目标文件路径（相对工作区根）' },
				line: { type: 'integer', description: '行号（1-based）' },
				column: { type: 'integer', description: '列号（1-based）' },
			},
			required: ['file', 'line', 'column'],
		},
		permissions: 'read',
	};

	private readonly vscodeImpl: VsCodeRefShim;

	constructor(opts?: { vscode?: VsCodeRefShim }) {
		super();
		this.vscodeImpl = opts?.vscode ?? defaultShim;
	}

	validate(args: Record<string, unknown>): void {
		requireStringArg(args, 'file');
		const line = args.line;
		const column = args.column;
		if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
			throw new ToolValidationError('参数 line 必须为大于等于 1 的整数');
		}
		if (typeof column !== 'number' || !Number.isInteger(column) || column < 1) {
			throw new ToolValidationError('参数 column 必须为大于等于 1 的整数');
		}
	}

	async execute(
		args: Record<string, unknown>,
		context: ToolContext
	): Promise<ToolExecutionResult> {
		const inputPath = args.file as string;
		const line = args.line as number;
		const column = args.column as number;
		const startedAt = Date.now();

		// 1. 路径安全解析
		let resolved;
		try {
			resolved = await resolveWithinRoots(inputPath, context.workspaceRoots, {
				followSymlinks: true,
			});
		} catch (err) {
			if (err instanceof PathGuardError) {
				return { status: 'error', error: err.message };
			}
			throw err;
		}

		// 2. 检查文件存在
		try {
			await fs.stat(resolved.fsPath);
		} catch {
			return { status: 'error', error: `文件不存在: ${inputPath}` };
		}

		// 3. 构造 URI 与位置（1-based -> 0-based）
		const uri = this.vscodeImpl.fileUri(resolved.fsPath);
		const position = this.vscodeImpl.position(line - 1, column - 1);

		// 4. 调用引用提供者
		let locations: unknown;
		try {
			locations = await this.vscodeImpl.executeCommand(
				'vscode.executeReferenceProvider',
				uri,
				position
			);
		} catch (err) {
			return {
				status: 'error',
				error: `查找引用失败: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		// 5. 映射结果（0-based -> 1-based）
		const workspaceRoot = context.workspaceRoots[0];
		const rawLocations = Array.isArray(locations) ? (locations as VsCodeLocation[]) : [];
		const mapped: ReferenceEntry[] = rawLocations.map((loc) => ({
			file: path.relative(workspaceRoot, loc.uri.fsPath).split(path.sep).join('/'),
			line: loc.range.start.line + 1,
			column: loc.range.start.character + 1,
		}));

		// 6. 截断：总数超 50 时按文件分组，每文件最多 10 条
		const total = mapped.length;
		let references: ReferenceEntry[] = mapped;
		let truncated: boolean | undefined;
		let totalOut: number | undefined;
		if (total > 50) {
			const byFile = new Map<string, ReferenceEntry[]>();
			for (const ref of mapped) {
				const arr = byFile.get(ref.file) ?? [];
				if (arr.length < 10) {
					arr.push(ref);
				}
				byFile.set(ref.file, arr);
			}
			references = [...byFile.values()].flat();
			truncated = true;
			totalOut = total;
		}

		// 7. 返回 JSON
		const output: { references: ReferenceEntry[]; truncated?: boolean; total?: number } = {
			references,
		};
		if (truncated) {
			output.truncated = true;
			output.total = totalOut;
		}

		return {
			status: 'success',
			result: JSON.stringify(output),
			metadata: { duration_ms: Date.now() - startedAt },
		};
	}
}
