import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { ListDirTool } from '../../../tools/fs/listDir';
import type { ToolContext } from '../../../tools/baseTool';

describe('ListDirTool', () => {
	let workspace: string;
	let tool: ListDirTool;

	async function makeContext(overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
		return { workspaceRoots: [workspace], ...overrides };
	}

	/** 解析条目 JSON（结果可能带分页提示后缀，先按空行分隔取 JSON 部分）。 */
	function parseEntries(result: string): Array<{ name: string; type: string; size: number; mtime: number; path: string }> {
		return JSON.parse(result.split('\n\n(')[0]);
	}

	async function writeFile(rel: string, content: string): Promise<void> {
		const abs = path.join(workspace, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content);
	}

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-listdir-'));
		tool = new ListDirTool();
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('列出目录条目（含类型/大小/路径）', async () => {
		// Arrange
		await writeFile('a.ts', 'export const a = 1;\n');
		await writeFile('src/b.ts', 'export const b = 2;\n');
		await fs.mkdir(path.join(workspace, 'lib'));
		// Act
		const result = await tool.execute({ path: '.' }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'success');
		const entries = parseEntries(result.result as string);
		const names = entries.map((e: { name: string }) => e.name);
		assert.ok(names.includes('a.ts'));
		assert.ok(names.includes('src'));
		assert.ok(names.includes('lib'));
		const a = entries.find((e: { name: string }) => e.name === 'a.ts');
		assert.ok(a); // 条目必须存在
		assert.strictEqual(a.type, 'file');
		assert.ok(a.size > 0);
	});

	it('type 过滤：仅目录', async () => {
		// Arrange
		await writeFile('a.ts', 'x');
		await fs.mkdir(path.join(workspace, 'lib'));
		// Act
		const result = await tool.execute({ path: '.', type: 'dir' }, await makeContext());
		// Assert
		const entries = parseEntries(result.result as string);
		assert.ok(entries.every((e: { type: string }) => e.type === 'dir'));
	});

	it('type 为 null 时按默认 all 处理', async () => {
		// 准备
		await writeFile('a.ts', 'x');
		await fs.mkdir(path.join(workspace, 'lib'));

		// 执行
		tool.validate({ path: '.', type: null });
		const result = await tool.execute(
			{ path: '.', type: null },
			await makeContext()
		);

		// 断言
		const entries = parseEntries(result.result as string);
		assert.ok(entries.some((entry: { type: string }) => entry.type === 'file'));
		assert.ok(entries.some((entry: { type: string }) => entry.type === 'dir'));
	});

	it('排除内置忽略目录（node_modules）', async () => {
		// Arrange
		await fs.mkdir(path.join(workspace, 'node_modules'));
		await writeFile('node_modules/dep.js', 'x');
		await writeFile('real.ts', 'x');
		// Act
		const result = await tool.execute({ path: '.' }, await makeContext());
		// Assert
		const names = parseEntries(result.result as string).map((e: { name: string }) => e.name);
		assert.ok(!names.includes('node_modules'));
		assert.ok(names.includes('real.ts'));
	});

	it('尊重 .gitignore 模式', async () => {
		// Arrange
		await writeFile('.gitignore', '*.log\nsecret.txt\n');
		await writeFile('app.log', 'x');
		await writeFile('secret.txt', 'x');
		await writeFile('keep.ts', 'x');
		// Act
		const result = await tool.execute({ path: '.' }, await makeContext());
		// Assert
		const names = parseEntries(result.result as string).map((e: { name: string }) => e.name);
		assert.ok(!names.includes('app.log'));
		assert.ok(!names.includes('secret.txt'));
		assert.ok(names.includes('keep.ts'));
	});

	it('recursive 递归列出（深度受限）', async () => {
		// Arrange
		await writeFile('a.ts', 'x');
		await writeFile('src/b.ts', 'x');
		await writeFile('src/sub/c.ts', 'x');
		// Act
		const result = await tool.execute(
			{ path: '.', recursive: true },
			await makeContext()
		);
		// Assert
		const paths = parseEntries(result.result as string).map((e: { path: string }) => e.path);
		assert.ok(paths.includes('a.ts'));
		assert.ok(paths.includes('src/b.ts'));
		assert.ok(paths.includes('src/sub/c.ts'));
	});

	it('拒绝越界路径', async () => {
		const result = await tool.execute(
			{ path: '../../../etc' },
			await makeContext()
		);
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('越界'));
	});

	it('非目录路径返回 error', async () => {
		// Arrange
		await writeFile('file.txt', 'x');
		// Act
		const result = await tool.execute({ path: 'file.txt' }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('不是目录'));
	});

	it('条目超过 limit 时返回首页并提示续读', async () => {
		// Arrange
		for (let i = 0; i < 5; i++) {
			await writeFile(`f${i}.ts`, 'x');
		}
		// Act
		const result = await tool.execute({ path: '.', limit: 2 }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'success');
		const entries = parseEntries(result.result as string);
		assert.strictEqual(entries.length, 2);
		assert.ok(result.result?.includes('Showing 2 of'));
		assert.ok(result.result?.includes('Use offset=3 to continue'));
		assert.strictEqual(result.metadata?.truncated, true);
	});

	it('条目在 limit 内时不带续读提示', async () => {
		// Arrange
		await writeFile('a.ts', 'x');
		await writeFile('b.ts', 'x');
		// Act
		const result = await tool.execute({ path: '.' }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(!result.result?.includes('Use offset='));
		assert.strictEqual(result.metadata?.truncated, false);
	});
});
