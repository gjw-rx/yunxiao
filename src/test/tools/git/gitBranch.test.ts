/**
 * GitBranchTool 单测 - 注入 mock SimpleGit，验证 list/create/checkout、校验与错误处理。
 */
import * as assert from 'assert';
import { GitBranchTool } from '../../../tools/git/gitBranch';
import { ToolValidationError } from '../../../core/errors';
import type { ToolContext } from '../../../tools/baseTool';
import type { SimpleGit, BranchSummary } from 'simple-git';

function makeContext(): ToolContext {
	return { workspaceRoots: ['/fake/workspace'], sessionId: 'sess-1' };
}

function makeBranchSummary(): BranchSummary {
	return {
		detached: false,
		current: 'main',
		all: ['main', 'feature'],
		branches: {
			main: { current: true, name: 'main', commit: 'abc123', label: '', linkedWorkTree: false },
			feature: { current: false, name: 'feature', commit: 'def456', label: '', linkedWorkTree: false },
		},
	} as BranchSummary;
}

describe('GitBranchTool', () => {
	it('list 返回分支列表并标记当前分支', async () => {
		// Arrange
		const git = {
			checkIsRepo: async () => true,
			branch: async () => makeBranchSummary(),
		} as unknown as SimpleGit;
		const tool = new GitBranchTool({ createClient: () => git });

		// Act
		const result = await tool.execute({}, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result!);
		assert.strictEqual(payload.current, 'main');
		assert.strictEqual(payload.branches.length, 2);
		const currentBranch = payload.branches.find((b: { name: string }) => b.name === 'main');
		assert.strictEqual(currentBranch.current, true);
		const featureBranch = payload.branches.find((b: { name: string }) => b.name === 'feature');
		assert.strictEqual(featureBranch.current, false);
	});

	it('create 调用 checkoutLocalBranch', async () => {
		// Arrange
		let createdName: string | undefined;
		const git = {
			checkIsRepo: async () => true,
			checkoutLocalBranch: async (name: string) => {
				createdName = name;
			},
		} as unknown as SimpleGit;
		const tool = new GitBranchTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ action: 'create', name: 'feature' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		assert.strictEqual(createdName, 'feature');
		assert.ok(result.result?.includes('feature'));
	});

	it('checkout 成功切换分支', async () => {
		// Arrange
		let checkoutTarget: string | undefined;
		const git = {
			checkIsRepo: async () => true,
			checkout: async (what: string) => {
				checkoutTarget = what;
				return '';
			},
		} as unknown as SimpleGit;
		const tool = new GitBranchTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ action: 'checkout', name: 'main' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		assert.strictEqual(checkoutTarget, 'main');
		assert.ok(result.result?.includes('main'));
	});

	it('checkout 失败（未提交更改）返回友好错误', async () => {
		// Arrange
		const git = {
			checkIsRepo: async () => true,
			checkout: async () => {
				throw new Error('Please commit your changes or stash them before you switch branches');
			},
		} as unknown as SimpleGit;
		const tool = new GitBranchTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ action: 'checkout', name: 'main' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('未提交'));
	});

	it('非 git 仓库返回 error', async () => {
		// Arrange
		const git = { checkIsRepo: async () => false } as unknown as SimpleGit;
		const tool = new GitBranchTool({ createClient: () => git });

		// Act
		const result = await tool.execute({}, makeContext());

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.error, '当前工作区不是 git 仓库');
	});

	it('validate 拒绝非法 action', () => {
		const tool = new GitBranchTool();
		assert.throws(() => tool.validate({ action: 'invalid' }), ToolValidationError);
	});

	it('validate 拒绝 create 缺少 name', () => {
		const tool = new GitBranchTool();
		assert.throws(() => tool.validate({ action: 'create' }), ToolValidationError);
	});

	it('validate 拒绝 checkout 缺少 name', () => {
		const tool = new GitBranchTool();
		assert.throws(() => tool.validate({ action: 'checkout' }), ToolValidationError);
	});
});
