import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { SearchFilesTool, parseRgJson } from '../../../tools/fs/searchFiles';
import type { ToolContext } from '../../../tools/baseTool';

/** 覆盖 spawnRg 以模拟 rg 缺失，强制 Node 回退。 */
class FallbackSearchFilesTool extends SearchFilesTool {
	protected spawnRg(): Promise<string> {
		const err = new Error('spawn rg ENOENT') as NodeJS.ErrnoException;
		err.code = 'ENOENT';
		return Promise.reject(err);
	}
}

/** 记录 ripgrep 调用次数，验证同一轮重复搜索不会重复执行进程。 */
class CountingSearchFilesTool extends SearchFilesTool {
	private calls = 0;

	protected spawnRg(): Promise<string> {
		this.calls++;
		return Promise.resolve(RG_JSON_FIXTURE);
	}

	/** 返回 ripgrep 的执行次数。 */
	getCalls(): number {
		return this.calls;
	}
}

const RG_JSON_FIXTURE = [
	'{"type":"begin","data":{"path":{"text":"f.txt"}}}',
	'{"type":"context","data":{"path":{"text":"f.txt"},"lines":{"text":"line1\\n"},"line_number":1}}',
	'{"type":"match","data":{"path":{"text":"f.txt"},"lines":{"text":"match here\\n"},"line_number":2,"submatches":[{"match":{"text":"match"},"start":0,"end":5}]}}',
	'{"type":"context","data":{"path":{"text":"f.txt"},"lines":{"text":"line3\\n"},"line_number":3}}',
	'{"type":"end","data":{"path":{"text":"f.txt"}}}',
].join('\n');

describe('searchFiles', () => {
	describe('parseRgJson (纯函数)', () => {
		it('解析 match 与上下文', () => {
			// Act
			const matches = parseRgJson(RG_JSON_FIXTURE, 1);
			// Assert
			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].file, 'f.txt');
			assert.strictEqual(matches[0].line, 2);
			assert.strictEqual(matches[0].column, 1);
			assert.strictEqual(matches[0].text, 'match here');
			assert.ok(matches[0].context?.includes('line1'));
			assert.ok(matches[0].context?.includes('line3'));
		});

		it('忽略非 match/context 行（begin/end/summary）', () => {
			const out =
				'{"type":"summary","data":{}}\n' +
				'{"type":"match","data":{"path":{"text":"a.ts"},"lines":{"text":"x\\n"},"line_number":4,"submatches":[{"start":0}]}}';
			const matches = parseRgJson(out, 0);
			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].file, 'a.ts');
		});

		it('跳过非法 JSON 行', () => {
			const out = 'not json\n{"type":"match","data":{"path":{"text":"a"},"lines":{"text":"x\\n"},"line_number":1,"submatches":[{"start":0}]}}';
			const matches = parseRgJson(out, 0);
			assert.strictEqual(matches.length, 1);
		});
	});

	describe('SearchFilesTool execute', () => {
		let workspace: string;
		let tool: SearchFilesTool;

		async function makeContext(overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
			return { workspaceRoots: [workspace], ...overrides };
		}

		beforeEach(async () => {
			workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-search-'));
			tool = new SearchFilesTool();
		});

		afterEach(async () => {
			await fs.rm(workspace, { recursive: true, force: true });
		});

		it('regex 模式找到匹配（ripgrep 可用时）', async () => {
			// Arrange
			await fs.writeFile(path.join(workspace, 'a.ts'), 'const x = 1;\nconst y = 2;\n');
			// Act
			const result = await tool.execute(
				{ pattern: 'const x', path: '.' },
				await makeContext()
			);
			// Assert
			assert.strictEqual(result.status, 'success');
			const parsed = JSON.parse(result.result as string);
			assert.ok(parsed.matches.length >= 1);
			assert.ok(parsed.matches.some((m: { file: string }) => m.file === 'a.ts'));
		});

		it('无匹配返回空列表', async () => {
			// Arrange
			await fs.writeFile(path.join(workspace, 'a.ts'), 'hello world\n');
			// Act
			const result = await tool.execute(
				{ pattern: 'nonexistent_zzz', path: '.' },
				await makeContext()
			);
			// Assert
			assert.strictEqual(result.status, 'success');
			const parsed = JSON.parse(result.result as string);
			assert.strictEqual(parsed.matches.length, 0);
		});

		it('同一轮重复搜索时复用已有结果', async () => {
			// Arrange
			const countingTool = new CountingSearchFilesTool();
			const context = await makeContext({ sessionId: 'session-1', runId: 'run-1' });
			// Act
			await countingTool.execute({ pattern: 'match', path: '.' }, context);
			const result = await countingTool.execute({ pattern: 'match', path: '.' }, context);
			// Assert
			assert.strictEqual(countingTool.getCalls(), 1);
			assert.strictEqual(result.metadata?.reused, true);
			assert.ok(result.result?.includes('已复用当前轮搜索结果'));
		});

		it('拒绝越界路径', async () => {
			const result = await tool.execute(
				{ pattern: 'x', path: '../../../etc' },
				await makeContext()
			);
			assert.strictEqual(result.status, 'error');
			assert.ok(result.error?.includes('越界'));
		});

		it('rg 缺失时回退 Node 原生搜索仍返回匹配', async () => {
			// Arrange
			const fallbackTool = new FallbackSearchFilesTool();
			await fs.writeFile(
				path.join(workspace, 'a.ts'),
				'line1\nfindme here\nline3\nline4\n'
			);
			// Act
			const result = await fallbackTool.execute(
				{ pattern: 'findme', path: '.' },
				await makeContext()
			);
			// Assert
			assert.strictEqual(result.status, 'success');
			const parsed = JSON.parse(result.result as string);
			assert.strictEqual(parsed.fallback, true);
			assert.ok(parsed.matches.length >= 1);
			const m = parsed.matches[0];
			assert.strictEqual(m.line, 2);
			assert.ok(m.text.includes('findme'));
		});

		it('Node 回退 glob 模式按文件名匹配', async () => {
			// Arrange
			const fallbackTool = new FallbackSearchFilesTool();
			await fs.writeFile(path.join(workspace, 'app.log'), 'x');
			await fs.writeFile(path.join(workspace, 'keep.ts'), 'x');
			// Act
			const result = await fallbackTool.execute(
				{ pattern: '*.log', mode: 'glob', path: '.' },
				await makeContext()
			);
			// Assert
			assert.strictEqual(result.status, 'success');
			const parsed = JSON.parse(result.result as string);
			assert.ok(parsed.matches.some((m: { file: string }) => m.file === 'app.log'));
			assert.ok(!parsed.matches.some((m: { file: string }) => m.file === 'keep.ts'));
		});
	});
});
