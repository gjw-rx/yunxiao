import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { WriteFileTool } from '../../../tools/fs/writeFile';
import type { ToolContext } from '../../../tools/baseTool';

describe('WriteFileTool', () => {
	let workspace: string;
	let tool: WriteFileTool;

	async function makeContext(overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
		return { workspaceRoots: [workspace], ...overrides };
	}

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-writefile-'));
		tool = new WriteFileTool();
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('创建新文件并自动建父目录', async () => {
		// Act
		const result = await tool.execute(
			{ path: 'src/utils/logger.ts', content: 'export const log = () => {}\n' },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('已创建'));
		const written = await fs.readFile(
			path.join(workspace, 'src/utils/logger.ts'),
			'utf8'
		);
		assert.strictEqual(written, 'export const log = () => {}\n');
		assert.deepStrictEqual(result.metadata?.affected_files, ['src/utils/logger.ts']);
	});

	it('覆盖现有文件', async () => {
		// Arrange
		const abs = path.join(workspace, 'existing.txt');
		await fs.writeFile(abs, 'old content');
		// Act
		const result = await tool.execute(
			{ path: 'existing.txt', content: 'new content' },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('已覆盖'));
		const written = await fs.readFile(abs, 'utf8');
		assert.strictEqual(written, 'new content');
	});

	it('允许写入空内容（创建空文件）', async () => {
		const result = await tool.execute(
			{ path: 'empty.txt', content: '' },
			await makeContext()
		);
		assert.strictEqual(result.status, 'success');
		const stat = await fs.stat(path.join(workspace, 'empty.txt'));
		assert.strictEqual(stat.size, 0);
	});

	it('拒绝越界路径', async () => {
		const result = await tool.execute(
			{ path: '../../../etc/yunxiao-test', content: 'x' },
			await makeContext()
		);
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('越界'));
	});

	it('写入失败时不残留临时文件', async () => {
		// Arrange：把目标父目录改成文件，使 mkdir/rename 失败
		const blocker = path.join(workspace, 'blocker');
		await fs.writeFile(blocker, 'x');
		// Act：试图在 blocker（文件）下创建子文件 -> 失败
		const result = await tool.execute(
			{ path: 'blocker/child.txt', content: 'x' },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'error');
		const dirEntries = await fs.readdir(workspace);
		assert.ok(!dirEntries.some((e) => e.endsWith('.tmp')));
	});

	it('expectedVersion 不匹配时仍覆盖写入', async () => {
		// 准备
		const abs = path.join(workspace, 'existing.txt');
		await fs.writeFile(abs, 'old content');

		// 执行
		const result = await tool.execute(
			{
				path: 'existing.txt',
				content: 'new content',
				expectedVersion: 'stale-version',
			},
			await makeContext()
		);

		// 断言
		assert.strictEqual(result.status, 'success');
		assert.strictEqual(await fs.readFile(abs, 'utf8'), 'new content');
	});

	it('validate 拒绝空 path 与非字符串 content', () => {
		assert.throws(() => tool.validate({ path: '', content: 'x' }));
		assert.throws(() => tool.validate({ path: 'a.txt', content: 123 as unknown }));
	});
});
