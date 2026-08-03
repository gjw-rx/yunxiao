/**
 * GitStatusTool 单测 - 注入 mock SimpleGit，验证状态映射、截断与错误处理。
 */
import * as assert from 'assert';
import { GitStatusTool } from '../../../tools/git/gitStatus';
import type { ToolContext } from '../../../tools/baseTool';
import type { SimpleGit, StatusResult } from 'simple-git';

/** 构造 StatusResult（提供合理默认值，可覆盖）。 */
function makeStatusResult(overrides: Partial<StatusResult> = {}): StatusResult {
	return {
		not_added: [],
		conflicted: [],
		created: [],
		deleted: [],
		modified: [],
		renamed: [],
		staged: [],
		files: [],
		ahead: 0,
		behind: 0,
		current: 'main',
		tracking: 'origin/main',
		detached: false,
		isClean: () => false,
		...overrides,
	} as StatusResult;
}

function makeContext(): ToolContext {
	return { workspaceRoots: ['/fake/workspace'], sessionId: 'sess-1' };
}

describe('GitStatusTool', () => {
	it('映射暂存/未暂存/未跟踪文件', async () => {
		// Arrange
		const status = makeStatusResult({
			current: 'feature',
			tracking: 'origin/feature',
			files: [
				{ path: 'staged.ts', index: 'M', working_dir: ' ' },
				{ path: 'unstaged.ts', index: ' ', working_dir: 'M' },
				{ path: 'both.ts', index: 'M', working_dir: 'M' },
			],
			not_added: ['untracked.ts'],
		});
		const git = {
			checkIsRepo: async () => true,
			status: async () => status,
		} as unknown as SimpleGit;
		const tool = new GitStatusTool({ createClient: () => git });

		// Act
		const result = await tool.execute({}, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result!);
		assert.strictEqual(payload.currentBranch, 'feature');
		assert.strictEqual(payload.trackingBranch, 'origin/feature');
		assert.strictEqual(payload.staged.length, 2);
		assert.strictEqual(payload.staged[0].file, 'staged.ts');
		assert.strictEqual(payload.staged[0].index, 'M');
		assert.strictEqual(payload.unstaged.length, 2);
		assert.strictEqual(payload.unstaged[0].file, 'unstaged.ts');
		assert.strictEqual(payload.unstaged[0].workingDir, 'M');
		assert.deepStrictEqual(payload.untracked, ['untracked.ts']);
		assert.strictEqual(typeof result.metadata?.duration_ms, 'number');
	});

	it('截断：超过 200 条暂存文件 -> truncated=true, total=201', async () => {
		// Arrange
		const files = [];
		for (let i = 0; i < 201; i++) {
			files.push({ path: `file${i}.ts`, index: 'A', working_dir: ' ' });
		}
		const status = makeStatusResult({ files });
		const git = {
			checkIsRepo: async () => true,
			status: async () => status,
		} as unknown as SimpleGit;
		const tool = new GitStatusTool({ createClient: () => git });

		// Act
		const result = await tool.execute({}, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result!);
		assert.strictEqual(payload.truncated, true);
		assert.strictEqual(payload.total, 201);
		assert.strictEqual(payload.staged.length, 200);
	});

	it('非 git 仓库返回 error', async () => {
		// Arrange
		const git = { checkIsRepo: async () => false } as unknown as SimpleGit;
		const tool = new GitStatusTool({ createClient: () => git });

		// Act
		const result = await tool.execute({}, makeContext());

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.error, '当前工作区不是 git 仓库');
	});

	it('无工作区返回 error', async () => {
		// Arrange
		const git = { checkIsRepo: async () => true } as unknown as SimpleGit;
		const tool = new GitStatusTool({ createClient: () => git });

		// Act
		const result = await tool.execute({}, { workspaceRoots: [], sessionId: 'sess-1' });

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('工作区'));
	});

	it('无文件变更时返回空列表', async () => {
		// Arrange
		const status = makeStatusResult();
		const git = {
			checkIsRepo: async () => true,
			status: async () => status,
		} as unknown as SimpleGit;
		const tool = new GitStatusTool({ createClient: () => git });

		// Act
		const result = await tool.execute({}, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result!);
		assert.deepStrictEqual(payload.staged, []);
		assert.deepStrictEqual(payload.unstaged, []);
		assert.deepStrictEqual(payload.untracked, []);
		assert.strictEqual(payload.truncated, undefined);
	});
});
