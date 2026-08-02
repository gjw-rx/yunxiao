import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { MoveFileTool } from '../../../tools/fs/moveFile';
import type { ToolContext } from '../../../tools/baseTool';

describe('MoveFileTool', () => {
	let workspace: string;
	let tool: MoveFileTool;

	async function makeContext(overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
		return { workspaceRoots: [workspace], ...overrides };
	}

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-move-'));
		tool = new MoveFileTool();
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('移动文件并自动建目标父目录', async () => {
		// Arrange
		const src = path.join(workspace, 'a.ts');
		await fs.writeFile(src, 'export const a = 1;\n');
		// Act
		const result = await tool.execute(
			{ from: 'a.ts', to: 'src/moved.ts' },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('已移动'));
		const moved = await fs.readFile(path.join(workspace, 'src/moved.ts'), 'utf8');
		assert.strictEqual(moved, 'export const a = 1;\n');
		await assert.rejects(() => fs.stat(src)); // 源已不在
	});

	it('覆盖已存在的目标文件', async () => {
		// Arrange
		await fs.writeFile(path.join(workspace, 'from.txt'), 'new');
		await fs.writeFile(path.join(workspace, 'to.txt'), 'old');
		// Act
		const result = await tool.execute(
			{ from: 'from.txt', to: 'to.txt' },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('覆盖'));
		const to = await fs.readFile(path.join(workspace, 'to.txt'), 'utf8');
		assert.strictEqual(to, 'new');
	});

	it('源不存在返回 error', async () => {
		const result = await tool.execute(
			{ from: 'nope.txt', to: 'b.txt' },
			await makeContext()
		);
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('源文件不存在'));
	});

	it('拒绝越界路径', async () => {
		const result = await tool.execute(
			{ from: '../../../etc/passwd', to: 'b.txt' },
			await makeContext()
		);
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('越界'));
	});

	it('affected_files 含 from 与 to', async () => {
		// Arrange
		await fs.writeFile(path.join(workspace, 'a.txt'), 'x');
		// Act
		const result = await tool.execute(
			{ from: 'a.txt', to: 'b.txt' },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.deepStrictEqual(result.metadata?.affected_files, ['a.txt', 'b.txt']);
	});
});
