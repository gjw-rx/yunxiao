/**
 * gitClient 单测 - 使用真实 git 操作验证工厂与仓库检测。
 */
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { createGitClient, isGitRepo } from '../../../tools/git/gitClient';

describe('createGitClient / isGitRepo', () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-git-'));
		workspace = await fs.realpath(workspace);
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('createGitClient 返回可执行 git 命令的客户端', async () => {
		// Arrange
		const git = createGitClient(workspace);

		// Act
		await git.init();
		const isRepo = await git.checkIsRepo();

		// Assert
		assert.strictEqual(isRepo, true);
	});

	it('isGitRepo 对已初始化仓库返回 true', async () => {
		// Arrange
		await createGitClient(workspace).init();

		// Act
		const result = await isGitRepo(workspace);

		// Assert
		assert.strictEqual(result, true);
	});

	it('isGitRepo 对非仓库目录返回 false', async () => {
		// Arrange — workspace 为空目录，未 init

		// Act
		const result = await isGitRepo(workspace);

		// Assert
		assert.strictEqual(result, false);
	});
});
