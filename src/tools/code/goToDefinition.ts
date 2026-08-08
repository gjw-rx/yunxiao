/**
 * code.go_to_definition - 通过 VSCode Language API 查找符号定义位置（只读）。
 *
 * 流程：pathGuard 解析 -> 校验文件存在 -> 调用 vscode.executeDefinitionProvider
 *   -> 处理 Location / LocationLink[] 多种返回 -> 映射为 { file, line, column }（1-based）。
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

/** vscode 定义查询所需的最小 shim（便于注入测试）。 */
export interface VsCodeDefShim {
	executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
	fileUri(fsPath: string): unknown;
	position(line: number, character: number): unknown;
}

/** VSCode Location 最小形状（executeDefinitionProvider 单个返回值）。 */
interface VsCodeLocation {
	uri: { fsPath: string };
	range: { start: { line: number; character: number } };
}

/** VSCode LocationLink 最小形状（executeDefinitionProvider 数组返回值）。 */
interface VsCodeLocationLink {
	targetUri: { fsPath: string };
	targetRange: { start: { line: number; character: number } };
}

/** 定义位置结果项（输出）。 */
interface DefinitionLocation {
	readonly file: string;
	readonly line: number;
	readonly column: number;
}

type VsCodeApi = typeof import('vscode');
function vscodeApi(): VsCodeApi {
	return require('vscode');
}

const defaultShim: VsCodeDefShim = {
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

export class GoToDefinitionTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'code.go_to_definition',
		description: '查找给定文件位置处符号的定义位置（经 VSCode Language API）。',
		parameters: {
			type: 'object',
			properties: {
				file: { type: 'string', description: '相对工作区根的文件路径' },
				line: { type: 'number', description: '行号（1-based）' },
				column: { type: 'number', description: '列号（1-based）' },
			},
			required: ['file', 'line', 'column'],
		},
		permissions: 'read',
	};

	private readonly vscodeImpl: VsCodeDefShim;

	constructor(opts?: { vscode?: VsCodeDefShim }) {
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

		// 4. 调用定义提供者
		let raw: unknown;
		try {
			raw = await this.vscodeImpl.executeCommand(
				'vscode.executeDefinitionProvider',
				uri,
				position
			);
		} catch (err) {
			return {
				status: 'error',
				error: `查询定义失败: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		// 5. 映射结果（0-based -> 1-based）
		const definitions = this.mapDefinitions(raw, context.workspaceRoots[0]);

		return {
			status: 'success',
			result: JSON.stringify({ definitions }),
			metadata: { duration_ms: Date.now() - startedAt },
		};
	}

	/** 将 vscode 返回的 Location / LocationLink[] 映射为统一的定义位置数组（1-based）。 */
	private mapDefinitions(raw: unknown, workspaceRoot: string): DefinitionLocation[] {
		if (raw === null || raw === undefined) {
			return [];
		}

		const items = Array.isArray(raw) ? raw : [raw];
		if (items.length === 0) {
			return [];
		}

		const results: DefinitionLocation[] = [];
		for (const item of items) {
			if (isLocationLink(item)) {
				const link = item as VsCodeLocationLink;
				results.push({
					file: path.relative(workspaceRoot, link.targetUri.fsPath).split(path.sep).join('/'),
					line: link.targetRange.start.line + 1,
					column: link.targetRange.start.character + 1,
				});
			} else if (isLocation(item)) {
				const loc = item as VsCodeLocation;
				results.push({
					file: path.relative(workspaceRoot, loc.uri.fsPath).split(path.sep).join('/'),
					line: loc.range.start.line + 1,
					column: loc.range.start.character + 1,
				});
			}
		}
		return results;
	}
}

/** 类型守卫：LocationLink（含 targetUri / targetRange）。 */
function isLocationLink(item: unknown): item is VsCodeLocationLink {
	return (
		typeof item === 'object' &&
		item !== null &&
		'targetUri' in item &&
		'targetRange' in item
	);
}

/** 类型守卫：Location（含 uri / range）。 */
function isLocation(item: unknown): item is VsCodeLocation {
	return (
		typeof item === 'object' &&
		item !== null &&
		'uri' in item &&
		'range' in item
	);
}
