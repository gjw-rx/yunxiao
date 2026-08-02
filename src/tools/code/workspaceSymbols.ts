/**
 * code.workspace_symbols - 按名称搜索工作区符号（read 权限，本地执行）。
 *
 * 通过 VSCode Language API（vscode.executeWorkspaceSymbolProvider）查询工作区内符号。
 * vscode 访问可注入，便于无 vscode 单测。
 */
import {
	BaseTool,
	requireStringArg,
	type ToolContext,
	type ToolExecutionResult,
} from '../baseTool';
import type { ToolSchema } from '../../core/types';
import { ToolValidationError } from '../../core/errors';

/** vscode 命令执行的最小 shim（便于注入测试）。 */
export interface VsCodeCommandsShim {
	executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
}

/** 默认 shim：懒加载 vscode 模块。 */
const defaultShim: VsCodeCommandsShim = {
	executeCommand(command, ...args) {
		const vscode = require('vscode');
		return vscode.commands.executeCommand(command, ...args);
	},
};

/** SymbolKind 枚举到可读字符串的映射。 */
const SYMBOL_KIND_MAP: Record<number, string> = {
	1: 'File',
	2: 'Module',
	3: 'Namespace',
	4: 'Package',
	5: 'Class',
	6: 'Method',
	7: 'Property',
	8: 'Field',
	9: 'Constructor',
	10: 'Enum',
	11: 'Interface',
	12: 'Function',
	13: 'Variable',
	14: 'Constant',
	15: 'String',
	16: 'Number',
	17: 'Boolean',
	18: 'Array',
	19: 'Object',
	20: 'Key',
	21: 'Null',
	22: 'EnumMember',
	23: 'Struct',
	24: 'Event',
	25: 'Operator',
	26: 'TypeParameter',
};

/** VSCode SymbolInformation 的最小结构。 */
interface SymbolInformation {
	name: string;
	kind: number;
	location: {
		uri: { fsPath: string };
		range: { start: { line: number; character: number } };
	};
}

/** 工作区符号搜索结果项。 */
interface WorkspaceSymbolItem {
	name: string;
	kind: string;
	file: string;
	line: number;
	column: number;
}

/** code.workspace_symbols 构造依赖。 */
export interface WorkspaceSymbolsToolOptions {
	readonly vscode?: VsCodeCommandsShim;
}

export class WorkspaceSymbolsTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'code.workspace_symbols',
		description: '按名称搜索工作区符号（函数、类、接口等），返回匹配符号的位置信息。',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: '符号名称查询字符串（非空）' },
			},
			required: ['query'],
		},
		permissions: 'read',
		site: 'local',
	};

	private readonly vscode: VsCodeCommandsShim;

	constructor(opts?: WorkspaceSymbolsToolOptions) {
		super();
		this.vscode = opts?.vscode ?? defaultShim;
	}

	validate(args: Record<string, unknown>): void {
		requireStringArg(args, 'query');
	}

	async execute(
		args: Record<string, unknown>,
		_context: ToolContext
	): Promise<ToolExecutionResult> {
		const query = args.query as string;

		let raw: unknown;
		try {
			raw = await this.vscode.executeCommand(
				'vscode.executeWorkspaceSymbolProvider',
				query
			);
		} catch (err) {
			return {
				status: 'error',
				error: `工作区符号搜索失败: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		const symbols = (raw as SymbolInformation[] | null | undefined) ?? [];
		const total = symbols.length;
		const truncated = total > 100;
		const limited = truncated ? symbols.slice(0, 100) : symbols;

		const items: WorkspaceSymbolItem[] = limited.map((s) => ({
			name: s.name,
			kind: SYMBOL_KIND_MAP[s.kind] ?? 'Symbol',
			file: s.location.uri.fsPath,
			line: s.location.range.start.line,
			column: s.location.range.start.character,
		}));

		const payload: { symbols: WorkspaceSymbolItem[]; truncated?: boolean; total?: number } = {
			symbols: items,
		};
		if (truncated) {
			payload.truncated = true;
			payload.total = total;
		}

		return {
			status: 'success',
			result: JSON.stringify(payload),
		};
	}
}
