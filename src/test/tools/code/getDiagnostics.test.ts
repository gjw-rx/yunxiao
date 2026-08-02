import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import {
	GetDiagnosticsTool,
	type VsCodeLanguageShim,
	type VsCodeDiagnostic,
} from '../../../tools/code/getDiagnostics';
import type { ToolContext } from '../../../tools/baseTool';

/** 构造诊断条目。 */
function makeDiag(
	severity: number,
	message: string,
	line: number = 0,
	source?: string
): VsCodeDiagnostic {
	return {
		severity,
		message,
		range: {
			start: { line, character: 0 },
			end: { line, character: 10 },
		},
		...(source !== undefined ? { source } : {}),
	};
}

/** 构造 mock vscode shim：按文件绝对路径返回诊断。 */
function makeMockVscode(
	diagsByAbsPath: Map<string, VsCodeDiagnostic[]>
): VsCodeLanguageShim {
	return {
		getDiagnostics(resource?: unknown) {
			if (resource !== undefined) {
				const fsPath = (resource as { fsPath: string }).fsPath;
				return [[resource, diagsByAbsPath.get(fsPath) ?? []]];
			}
			return Array.from(diagsByAbsPath.entries()).map(([fsPath, diags]) => [
				{ fsPath },
				diags,
			]);
		},
		fileUri(fsPath: string) {
			return { fsPath };
		},
	};
}

describe('GetDiagnosticsTool', () => {
	let workspace: string;

	async function makeContext(overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
		return { workspaceRoots: [workspace], sessionId: 'sess-1', ...overrides };
	}

	async function writeFile(rel: string, content: string): Promise<void> {
		const abs = path.join(workspace, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content);
	}

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-diag-'));
		workspace = await fs.realpath(workspace);
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('查询指定文件的诊断（2 error + 1 warning）', async () => {
		// Arrange
		await writeFile('test.ts', 'const x: string = 42;\n');
		const absPath = path.join(workspace, 'test.ts');
		const mock = makeMockVscode(new Map([
			[absPath, [
				makeDiag(0, 'Type error', 0, 'ts'),
				makeDiag(0, 'Another error', 1, 'ts'),
				makeDiag(1, 'Warning message', 2, 'eslint'),
			]],
		]));
		const tool = new GetDiagnosticsTool({ vscode: mock });

		// Act
		const result = await tool.execute({ file: 'test.ts' }, await makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result!);
		assert.strictEqual(payload.diagnostics.length, 3);
		assert.strictEqual(payload.diagnostics.filter((d: { severity: string }) => d.severity === 'error').length, 2);
		assert.strictEqual(payload.diagnostics.filter((d: { severity: string }) => d.severity === 'warning').length, 1);
		assert.strictEqual(payload.diagnostics[0].file, 'test.ts');
		assert.strictEqual(payload.diagnostics[0].source, 'ts');
	});

	it('查询全工作区诊断（无 file 参数）', async () => {
		// Arrange
		await writeFile('a.ts', 'x\n');
		await writeFile('b.ts', 'y\n');
		const absA = path.join(workspace, 'a.ts');
		const absB = path.join(workspace, 'b.ts');
		const mock = makeMockVscode(new Map([
			[absA, [makeDiag(0, 'error in a')]],
			[absB, [makeDiag(1, 'warning in b'), makeDiag(2, 'info in b')]],
		]));
		const tool = new GetDiagnosticsTool({ vscode: mock });

		// Act
		const result = await tool.execute({}, await makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result!);
		assert.strictEqual(payload.diagnostics.length, 3);
		const files = new Set(payload.diagnostics.map((d: { file: string }) => d.file));
		assert.ok(files.has('a.ts'));
		assert.ok(files.has('b.ts'));
	});

	it('截断：60 条诊断（10 error + 30 warning + 20 info）-> truncated=true, total=60', async () => {
		// Arrange
		await writeFile('big.ts', 'x\n');
		const absPath = path.join(workspace, 'big.ts');
		const diags: VsCodeDiagnostic[] = [];
		for (let i = 0; i < 10; i++) {
			diags.push(makeDiag(0, `error ${i}`, i));
		}
		for (let i = 0; i < 30; i++) {
			diags.push(makeDiag(1, `warning ${i}`, i));
		}
		for (let i = 0; i < 20; i++) {
			diags.push(makeDiag(2, `info ${i}`, i));
		}
		const mock = makeMockVscode(new Map([[absPath, diags]]));
		const tool = new GetDiagnosticsTool({ vscode: mock });

		// Act
		const result = await tool.execute({ file: 'big.ts' }, await makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result!);
		assert.strictEqual(payload.truncated, true);
		assert.strictEqual(payload.total, 60);
		// 10 errors + 20 warnings = 30
		assert.strictEqual(payload.diagnostics.length, 30);
		assert.strictEqual(payload.diagnostics.filter((d: { severity: string }) => d.severity === 'error').length, 10);
		assert.strictEqual(payload.diagnostics.filter((d: { severity: string }) => d.severity === 'warning').length, 20);
		// 无 info/hint
		assert.strictEqual(payload.diagnostics.filter((d: { severity: string }) => d.severity === 'info').length, 0);
	});

	it('文件不存在返回 error', async () => {
		// Arrange
		const mock = makeMockVscode(new Map());
		const tool = new GetDiagnosticsTool({ vscode: mock });

		// Act
		const result = await tool.execute({ file: 'nonexistent.ts' }, await makeContext());

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('不存在'));
	});

	it('路径越界被拒绝', async () => {
		// Arrange
		const mock = makeMockVscode(new Map());
		const tool = new GetDiagnosticsTool({ vscode: mock });

		// Act
		const result = await tool.execute({ file: '../../../etc/passwd' }, await makeContext());

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('越界'));
	});

	it('无语言服务诊断返回空数组', async () => {
		// Arrange
		await writeFile('empty.ts', 'x\n');
		const mock = makeMockVscode(new Map());
		const tool = new GetDiagnosticsTool({ vscode: mock });

		// Act
		const result = await tool.execute({ file: 'empty.ts' }, await makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result!);
		assert.deepStrictEqual(payload.diagnostics, []);
	});

	it('validate 拒绝空 file 字符串', () => {
		const tool = new GetDiagnosticsTool();
		assert.throws(() => tool.validate({ file: '' }));
	});
});
