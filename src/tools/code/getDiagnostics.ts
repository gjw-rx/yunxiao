/**
 * code.get_diagnostics - 查询 VSCode 语言服务诊断（lint/类型错误等，只读）。
 *
 * 两种模式：
 * - { file }: 查询指定文件的诊断。经 pathGuard 解析 -> 校验存在 -> vscode.getDiagnostics(uri)。
 * - 无参数: 查询全工作区诊断，调用 vscode.getDiagnostics()。
 *
 * 诊断严重级别映射：0=Error, 1=Warning, 2=Info, 3=Hint。
 * 超过 50 条时截断：保留全部 error + 至多 20 条 warning，省略 info/hint。
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
import { PathGuardError } from '../../core/errors';
import type { ToolSchema } from '../../core/types';

/** vscode 语言服务诊断条目（shim 用）。 */
export interface VsCodeDiagnostic {
	readonly severity: number;
	readonly message: string;
	readonly source?: string;
	readonly range: {
		readonly start: { readonly line: number; readonly character: number };
		readonly end: { readonly line: number; readonly character: number };
	};
}

/** vscode 语言服务能力的最小 shim（便于注入测试）。 */
export interface VsCodeLanguageShim {
	getDiagnostics(resource?: unknown): [unknown, VsCodeDiagnostic[]][];
	fileUri(fsPath: string): unknown;
}

type VsCodeApi = typeof import('vscode');
function vscodeApi(): VsCodeApi {
	return require('vscode');
}

const defaultShim: VsCodeLanguageShim = {
	getDiagnostics(resource?: unknown) {
		const api = vscodeApi();
		if (resource !== undefined) {
			const diags = api.languages.getDiagnostics(resource as import('vscode').Uri);
			return [[resource, diags]];
		}
		return api.languages.getDiagnostics();
	},
	fileUri(fsPath: string) {
		return vscodeApi().Uri.file(fsPath);
	},
};

/** 诊断严重级别映射：0=Error, 1=Warning, 2=Info, 3=Hint。 */
function severityToString(severity: number): string {
	switch (severity) {
		case 0:
			return 'error';
		case 1:
			return 'warning';
		case 2:
			return 'info';
		case 3:
			return 'hint';
		default:
			return 'unknown';
	}
}

/** 诊断条目总数超过此阈值时触发截断。 */
const MAX_DIAGNOSTICS = 50;
/** 截断时保留的告警上限。 */
const MAX_WARNINGS_KEPT = 20;

/** 映射后的诊断条目。 */
interface MappedDiagnostic {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly severity: string;
	readonly message: string;
	readonly source?: string;
}

/** 从 resource 提取 fsPath。 */
function resourceToFsPath(resource: unknown): string | undefined {
	if (resource && typeof resource === 'object' && 'fsPath' in resource) {
		return (resource as { fsPath: string }).fsPath;
	}
	return undefined;
}

/** 将绝对路径转为相对工作区根的路径（无匹配则返回原值）。 */
function toRelativePath(fsPath: string, roots: string[]): string {
	for (const root of roots) {
		const rel = path.relative(root, fsPath);
		if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
			return rel;
		}
	}
	return fsPath;
}

/** 将 vscode 诊断元组映射为简化结构。 */
function mapDiagnostics(
	tuples: [unknown, VsCodeDiagnostic[]][],
	workspaceRoots: string[]
): MappedDiagnostic[] {
	const mapped: MappedDiagnostic[] = [];
	for (const [resource, diags] of tuples) {
		const fsPath = resourceToFsPath(resource);
		const file = fsPath ? toRelativePath(fsPath, workspaceRoots) : '<unknown>';
		for (const d of diags) {
			mapped.push({
				file,
				line: d.range.start.line,
				column: d.range.start.character,
				endLine: d.range.end.line,
				endColumn: d.range.end.character,
				severity: severityToString(d.severity),
				message: d.message,
				...(d.source !== undefined ? { source: d.source } : {}),
			});
		}
	}
	return mapped;
}

/** 超过阈值时截断：保留全部 error + 至多 20 条 warning，省略 info/hint。 */
function truncateDiagnostics(
	diags: MappedDiagnostic[]
): { diagnostics: MappedDiagnostic[]; truncated: boolean; total: number } {
	const total = diags.length;
	if (total <= MAX_DIAGNOSTICS) {
		return { diagnostics: diags, truncated: false, total };
	}
	const errors = diags.filter((d) => d.severity === 'error');
	const warnings = diags
		.filter((d) => d.severity === 'warning')
		.slice(0, MAX_WARNINGS_KEPT);
	return {
		diagnostics: [...errors, ...warnings],
		truncated: true,
		total,
	};
}

export class GetDiagnosticsTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'code.get_diagnostics',
		description: '查询 VSCode 语言服务诊断（lint/类型错误等），可指定文件或全工作区。',
		parameters: {
			type: 'object',
			properties: {
				file: {
					type: 'string',
					description: '相对工作区根的文件路径（省略则查询全工作区）',
				},
			},
		},
		permissions: 'read',
		site: 'local',
	};

	private readonly vscode: VsCodeLanguageShim;

	constructor(opts: { vscode?: VsCodeLanguageShim } = {}) {
		super();
		this.vscode = opts.vscode ?? defaultShim;
	}

	validate(args: Record<string, unknown>): void {
		if (args.file !== undefined) {
			requireStringArg(args, 'file');
		}
	}

	async execute(
		args: Record<string, unknown>,
		context: ToolContext
	): Promise<ToolExecutionResult> {
		const startedAt = Date.now();

		// 1. 指定文件模式
		if (args.file !== undefined) {
			const inputPath = args.file as string;

			// 1a. 路径安全解析
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

			// 1b. 校验文件存在
			try {
				await fs.stat(resolved.fsPath);
			} catch {
				return { status: 'error', error: `文件不存在: ${inputPath}` };
			}

			// 1c. 查询诊断
			const uri = this.vscode.fileUri(resolved.fsPath);
			const tuples = this.vscode.getDiagnostics(uri);
			const mapped = mapDiagnostics(tuples, context.workspaceRoots);
			const { diagnostics, truncated, total } = truncateDiagnostics(mapped);

			const output: { diagnostics: MappedDiagnostic[]; truncated?: boolean; total?: number } = {
				diagnostics,
			};
			if (truncated) {
				output.truncated = true;
				output.total = total;
			}

			return {
				status: 'success',
				result: JSON.stringify(output),
				metadata: { duration_ms: Date.now() - startedAt },
			};
		}

		// 2. 全工作区模式
		const tuples = this.vscode.getDiagnostics();
		const mapped = mapDiagnostics(tuples, context.workspaceRoots);
		const { diagnostics, truncated, total } = truncateDiagnostics(mapped);

		const output: { diagnostics: MappedDiagnostic[]; truncated?: boolean; total?: number } = {
			diagnostics,
		};
		if (truncated) {
			output.truncated = true;
			output.total = total;
		}

		return {
			status: 'success',
			result: JSON.stringify(output),
			metadata: { duration_ms: Date.now() - startedAt },
		};
	}
}
