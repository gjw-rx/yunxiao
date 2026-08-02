import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { FindReferencesTool, type VsCodeRefShim } from '../../../tools/code/findReferences';
import type { ToolContext } from '../../../tools/baseTool';
import { ToolValidationError } from '../../../core/errors';

/** VSCode Location 形状（测试用）。 */
interface MockLocation {
	uri: { fsPath: string };
	range: { start: { line: number; character: number } };
}

/** 构造 mock VsCodeRefShim：记录调用参数并返回预设 Location[]。 */
function mockVsCodeShim(opts: { locations?: MockLocation[]; throwOnExecute?: Error } = {}) {
	const calls: { command: string; args: unknown[] }[] = [];
	const positions: { line: number; character: number }[] = [];
	const shim: VsCodeRefShim = {
		executeCommand: async (command, ...args) => {
			calls.push({ command, args });
			if (opts.throwOnExecute) {
				throw opts.throwOnExecute;
			}
			return opts.locations ?? [];
		},
		fileUri: (fsPath) => ({ fsPath }),
		position: (line, character) => {
			positions.push({ line, character });
			return { line, character };
		},
	};
	return { shim, calls, positions };
}

describe('FindReferencesTool', () => {
	let workspace: string;

	async function makeContext(overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
		return { workspaceRoots: [workspace], ...overrides };
	}

	async function writeFile(rel: string, content: string): Promise<void> {
		const abs = path.join(workspace, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content);
	}

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-findrefs-'));
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('查找引用成功 - 多文件多位置', async () => {
		// Arrange
		await writeFile('src/a.ts', 'export function foo() {}\n');
		await writeFile('src/b.ts', 'import { foo } from "./a";\n');
		const { shim } = mockVsCodeShim({
			locations: [
				{ uri: { fsPath: path.join(workspace, 'src/a.ts') }, range: { start: { line: 0, character: 16 } } },
				{ uri: { fsPath: path.join(workspace, 'src/a.ts') }, range: { start: { line: 1, character: 0 } } },
				{ uri: { fsPath: path.join(workspace, 'src/b.ts') }, range: { start: { line: 0, character: 9 } } },
			],
		});
		const tool = new FindReferencesTool({ vscode: shim });
		// Act
		const result = await tool.execute(
			{ file: 'src/a.ts', line: 1, column: 17 },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'success');
		const parsed = JSON.parse(result.result!);
		assert.strictEqual(parsed.references.length, 3);
		assert.strictEqual(parsed.references[0].file, 'src/a.ts');
		assert.strictEqual(parsed.references[0].line, 1);
		assert.strictEqual(parsed.references[0].column, 17);
		assert.strictEqual(parsed.references[1].file, 'src/a.ts');
		assert.strictEqual(parsed.references[1].line, 2);
		assert.strictEqual(parsed.references[2].file, 'src/b.ts');
		assert.strictEqual(parsed.references[2].line, 1);
		assert.strictEqual(parsed.references[2].column, 10);
	});

	it('无引用返回空数组', async () => {
		// Arrange
		await writeFile('a.ts', 'const x = 1;\n');
		const { shim } = mockVsCodeShim({ locations: [] });
		const tool = new FindReferencesTool({ vscode: shim });
		// Act
		const result = await tool.execute(
			{ file: 'a.ts', line: 1, column: 7 },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'success');
		const parsed = JSON.parse(result.result!);
		assert.strictEqual(parsed.references.length, 0);
		assert.strictEqual(parsed.truncated, undefined);
	});

	it('截断：80 条引用跨 5 文件 -> truncated=true, total=80, 每文件最多 10 条', async () => {
		// Arrange
		await writeFile('target.ts', 'export function foo() {}\n');
		const locations: MockLocation[] = [];
		for (let f = 0; f < 5; f++) {
			for (let i = 0; i < 16; i++) {
				locations.push({
					uri: { fsPath: path.join(workspace, `file${f}.ts`) },
					range: { start: { line: i, character: 0 } },
				});
			}
		}
		assert.strictEqual(locations.length, 80);
		const { shim } = mockVsCodeShim({ locations });
		const tool = new FindReferencesTool({ vscode: shim });
		// Act
		const result = await tool.execute(
			{ file: 'target.ts', line: 1, column: 17 },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'success');
		const parsed = JSON.parse(result.result!);
		assert.strictEqual(parsed.truncated, true);
		assert.strictEqual(parsed.total, 80);
		// 每文件最多 10 条，5 文件 = 50 条
		assert.strictEqual(parsed.references.length, 50);
		const byFile = new Map<string, number>();
		for (const ref of parsed.references) {
			byFile.set(ref.file, (byFile.get(ref.file) ?? 0) + 1);
		}
		for (const count of byFile.values()) {
			assert.strictEqual(count, 10, '每文件应最多 10 条');
		}
	});

	it('1-based 转 0-based：position 以 line-1, column-1 调用', async () => {
		// Arrange
		await writeFile('a.ts', 'const x = 1;\n');
		const { shim, positions } = mockVsCodeShim({ locations: [] });
		const tool = new FindReferencesTool({ vscode: shim });
		// Act
		await tool.execute(
			{ file: 'a.ts', line: 5, column: 10 },
			await makeContext()
		);
		// Assert
		assert.strictEqual(positions.length, 1);
		assert.strictEqual(positions[0].line, 4); // 5-1
		assert.strictEqual(positions[0].character, 9); // 10-1
	});

	it('validate 拒绝 line=0（必须 >= 1）', () => {
		const tool = new FindReferencesTool();
		assert.throws(
			() => tool.validate({ file: 'a.ts', line: 0, column: 1 }),
			ToolValidationError
		);
	});

	it('路径越界被拒绝', async () => {
		const { shim } = mockVsCodeShim({ locations: [] });
		const tool = new FindReferencesTool({ vscode: shim });
		const result = await tool.execute(
			{ file: '../../../etc/passwd', line: 1, column: 1 },
			await makeContext()
		);
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('越界'));
	});

	it('文件不存在返回错误', async () => {
		const { shim } = mockVsCodeShim({ locations: [] });
		const tool = new FindReferencesTool({ vscode: shim });
		const result = await tool.execute(
			{ file: 'nonexistent.ts', line: 1, column: 1 },
			await makeContext()
		);
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('文件不存在'));
	});
});
