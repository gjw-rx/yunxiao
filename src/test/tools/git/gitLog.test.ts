/**
 * GitLogTool 单测 - 注入 mock SimpleGit，验证参数透传、结果映射、校验与错误处理。
 */
import * as assert from 'assert';
import { GitLogTool } from '../../../tools/git/gitLog';
import { ToolValidationError } from '../../../core/errors';
import type { ToolContext } from '../../../tools/baseTool';
import type { DefaultLogFields, ListLogSummary, SimpleGit } from 'simple-git';

/** 构造 ListLogSummary（提供合理默认值，可覆盖）。 */
function makeLogSummary(commits: Partial<DefaultLogFields>[] = []): ListLogSummary<DefaultLogFields> {
	return {
		all: commits.map((c) => ({
			hash: 'abc123',
			date: '2026-08-01T00:00:00+08:00',
			message: 'fix: something',
			refs: '',
			body: '',
			author_name: 'Alice',
			author_email: 'alice@example.com',
			...c,
		})),
		total: commits.length,
		latest: null,
	} as ListLogSummary<DefaultLogFields>;
}

function makeContext(): ToolContext {
	return { workspaceRoots: ['/fake/workspace'], sessionId: 'sess-1' };
}

describe('GitLogTool', () => {
	it('默认 maxCount=20，映射提交字段', async () => {
		// Arrange
		let receivedOpts: unknown;
		const git = {
			checkIsRepo: async () => true,
			log: async (opts: unknown) => {
				receivedOpts = opts;
				return makeLogSummary([
					{ hash: 'aaa111', author_name: 'Bob', message: 'feat: first' },
					{ hash: 'bbb222', author_name: 'Alice', message: 'feat: second' },
				]);
			},
		} as unknown as SimpleGit;
		const tool = new GitLogTool({ createClient: () => git });

		// Act
		const result = await tool.execute({}, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		assert.deepStrictEqual(receivedOpts, { maxCount: 20 });
		const payload = JSON.parse(result.result!);
		assert.strictEqual(payload.count, 2);
		assert.deepStrictEqual(payload.commits[0], {
			hash: 'aaa111',
			author: 'Bob',
			date: '2026-08-01T00:00:00+08:00',
			message: 'feat: first',
		});
		assert.strictEqual(typeof result.metadata?.duration_ms, 'number');
	});

	it('透传 maxCount 与 path', async () => {
		// Arrange
		let receivedOpts: unknown;
		const git = {
			checkIsRepo: async () => true,
			log: async (opts: unknown) => {
				receivedOpts = opts;
				return makeLogSummary();
			},
		} as unknown as SimpleGit;
		const tool = new GitLogTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ maxCount: 5, path: 'src/a.ts' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		assert.deepStrictEqual(receivedOpts, { maxCount: 5, file: 'src/a.ts' });
	});

	it('非 git 仓库返回 error', async () => {
		// Arrange
		const git = { checkIsRepo: async () => false } as unknown as SimpleGit;
		const tool = new GitLogTool({ createClient: () => git });

		// Act
		const result = await tool.execute({}, makeContext());

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.error, '当前工作区不是 git 仓库');
	});

	it('无工作区返回 error', async () => {
		// Arrange
		const git = { checkIsRepo: async () => true } as unknown as SimpleGit;
		const tool = new GitLogTool({ createClient: () => git });

		// Act
		const result = await tool.execute({}, { workspaceRoots: [], sessionId: 'sess-1' });

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('工作区'));
	});

	it('validate：非法 maxCount 抛 ToolValidationError', () => {
		// Arrange
		const tool = new GitLogTool();
		const badValues = [0, -1, 1.5, 201, '5'];

		// Act & Assert
		for (const value of badValues) {
			assert.throws(() => tool.validate({ maxCount: value }), ToolValidationError);
		}
		assert.doesNotThrow(() => tool.validate({ maxCount: 1 }));
		assert.doesNotThrow(() => tool.validate({ maxCount: 200 }));
	});

	it('validate：空 path 抛 ToolValidationError', () => {
		// Arrange
		const tool = new GitLogTool();

		// Act & Assert
		assert.throws(() => tool.validate({ path: '' }), ToolValidationError);
		assert.doesNotThrow(() => tool.validate({ path: 'src/a.ts' }));
	});
});
