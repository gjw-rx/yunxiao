import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { DeleteFileTool } from '../../../tools/fs/deleteFile';
import type { ToolContext } from '../../../tools/baseTool';

describe('DeleteFileTool', () => {
	let workspace: string;
	let tool: DeleteFileTool;

	async function makeContext(overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
		return { workspaceRoots: [workspace], ...overrides };
	}

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-delete-'));
		// 注入永久删除（测试不依赖回收站）
		tool = new DeleteFileTool({
			deleteFn: async (p, recursive) => {
				await fs.rm(p, { recursive, force: true });
				return { permanent: true };
			},
		});
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('删除文件成功', async () => {
		// Arrange
		const abs = path.join(workspace, 'to-delete.txt');
		await fs.writeFile(abs, 'x');
		// Act
		const result = await tool.execute({ path: 'to-delete.txt' }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'success');
		await assert.rejects(() => fs.stat(abs));
	});

	it('回收站删除标注 permanent=false', async () => {
		// Arrange
		const abs = path.join(workspace, 'trash.txt');
		await fs.writeFile(abs, 'x');
		const trashTool = new DeleteFileTool({
			deleteFn: async () => ({ permanent: false }),
		});
		// Act
		const result = await trashTool.execute({ path: 'trash.txt' }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('回收站'));
	});

	it('递归删除目录', async () => {
		// Arrange
		await fs.mkdir(path.join(workspace, 'dir'));
		await fs.writeFile(path.join(workspace, 'dir/inner.txt'), 'x');
		// Act
		const result = await tool.execute(
			{ path: 'dir', recursive: true },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'success');
		await assert.rejects(() => fs.stat(path.join(workspace, 'dir')));
	});

	it('文件不存在返回 error', async () => {
		const result = await tool.execute({ path: 'nope.txt' }, await makeContext());
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('不存在'));
	});

	it('拒绝越界路径', async () => {
		const result = await tool.execute(
			{ path: '../../../etc/yunxiao-test' },
			await makeContext()
		);
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('越界'));
	});
});
