import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { GoToDefinitionTool, type VsCodeDefShim } from '../../../tools/code/goToDefinition';
import { ToolValidationError } from '../../../core/errors';
import type { ToolContext } from '../../../tools/baseTool';

/** 构造 mock VsCodeDefShim，返回预设定义结果并记录调用。 */
function mockShim(definitionResult: unknown = null): {
	shim: VsCodeDefShim;
	positionCalls: { line: number; character: number }[];
} {
	const positionCalls: { line: number; character: number }[] = [];
	const shim: VsCodeDefShim = {
		executeCommand: async () => definitionResult,
		fileUri: (fsPath) => ({ fsPath }),
		position: (line, character) => {
			positionCalls.push({ line, character });
			return { line, character };
		},
	};
	return { shim, positionCalls };
}

describe('GoToDefinitionTool', () => {
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
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-gotodef-'));
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('单个 Location 返回 -> 正确映射 definitions 数组', async () => {
		// Arrange
		await writeFile('src.ts', 'export function foo() {}\n');
		await writeFile('target.ts', 'export const bar = 1;\n');
		const loc = {
			uri: { fsPath: path.join(workspace, 'target.ts') },
			range: { start: { line: 5, character: 10 } },
		};
		const { shim } = mockShim(loc);
		const tool = new GoToDefinitionTool({ vscode: shim });

		// Act
		const result = await tool.execute(
			{ file: 'src.ts', line: 1, column: 1 },
			await makeContext()
		);

		// Assert
		assert.strictEqual(result.status, 'success');
		const parsed = JSON.parse(result.result!);
		assert.deepStrictEqual(parsed.definitions, [
			{ file: 'target.ts', line: 6, column: 11 },
		]);
	});

	it('无定义 -> 空数组 success', async () => {
		// Arrange
		await writeFile('src.ts', 'export function foo() {}\n');
		const { shim } = mockShim(null);
		const tool = new GoToDefinitionTool({ vscode: shim });

		// Act
		const result = await tool.execute(
			{ file: 'src.ts', line: 1, column: 1 },
			await makeContext()
		);

		// Assert
		assert.strictEqual(result.status, 'success');
		const parsed = JSON.parse(result.result!);
		assert.deepStrictEqual(parsed.definitions, []);
	});

	it('1-based 转 0-based：position 以 line-1, column-1 调用', async () => {
		// Arrange
		await writeFile('src.ts', 'export function foo() {}\n');
		const { shim, positionCalls } = mockShim(null);
		const tool = new GoToDefinitionTool({ vscode: shim });

		// Act
		await tool.execute(
			{ file: 'src.ts', line: 5, column: 10 },
			await makeContext()
		);

		// Assert
		assert.deepStrictEqual(positionCalls, [{ line: 4, character: 9 }]);
	});

	it('LocationLink[] 返回类型 -> 正确映射', async () => {
		// Arrange
		await writeFile('src.ts', 'import { bar } from "./target";\n');
		await writeFile('target.ts', 'export const bar = 1;\n');
		const links = [
			{
				targetUri: { fsPath: path.join(workspace, 'target.ts') },
				targetRange: { start: { line: 3, character: 7 } },
			},
		];
		const { shim } = mockShim(links);
		const tool = new GoToDefinitionTool({ vscode: shim });

		// Act
		const result = await tool.execute(
			{ file: 'src.ts', line: 1, column: 10 },
			await makeContext()
		);

		// Assert
		assert.strictEqual(result.status, 'success');
		const parsed = JSON.parse(result.result!);
		assert.deepStrictEqual(parsed.definitions, [
			{ file: 'target.ts', line: 4, column: 8 },
		]);
	});

	it('validate 拒绝 line=0', () => {
		const tool = new GoToDefinitionTool({ vscode: mockShim().shim });
		assert.throws(
			() => tool.validate({ file: 'a.ts', line: 0, column: 1 }),
			ToolValidationError
		);
	});

	it('路径越界被拒绝 -> error', async () => {
		const tool = new GoToDefinitionTool({ vscode: mockShim().shim });
		const result = await tool.execute(
			{ file: '../../../etc/passwd', line: 1, column: 1 },
			await makeContext()
		);
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('越界'));
	});

	it('文件不存在 -> error', async () => {
		const tool = new GoToDefinitionTool({ vscode: mockShim().shim });
		const result = await tool.execute(
			{ file: 'nonexistent.ts', line: 1, column: 1 },
			await makeContext()
		);
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('不存在'));
	});
});
