import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { ReadFileTool, redactSecrets } from '../../../tools/fs/readFile';
import type { ToolContext } from '../../../tools/baseTool';

describe('ReadFileTool', () => {
	let workspace: string;
	let tool: ReadFileTool;

	async function makeContext(overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
		return { workspaceRoots: [workspace], ...overrides };
	}

	async function writeFile(rel: string, content: string | Buffer): Promise<void> {
		const abs = path.join(workspace, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content);
	}

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-readfile-'));
		tool = new ReadFileTool();
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('reads a small text file successfully', async () => {
		// Arrange
		await writeFile('src/extension.ts', 'export function activate() {}\n');
		// Act
		const result = await tool.execute({ path: 'src/extension.ts' }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('export function activate'));
		assert.ok(typeof result.metadata?.duration_ms === 'number');
	});

	it('returns error for a non-existent file', async () => {
		// Arrange / Act
		const result = await tool.execute({ path: 'nope.ts' }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('文件不存在'));
	});

	it('大文件不再整体拒绝，按预算返回首页（非 error）', async () => {
		// Arrange：maxFileSize 护栏很小，但文件仍应分页返回而非报错
		await writeFile('big.txt', 'x'.repeat(100));
		// Act
		const result = await tool.execute({ path: 'big.txt' }, await makeContext({ maxFileSize: 10 }));
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('Output capped'));
	});

	it('分页续读：offset/limit 返回指定行区间并提示续读', async () => {
		// Arrange
		await writeFile('multi.txt', 'line1\nline2\nline3\nline4\nline5\n');
		// Act
		const result = await tool.execute(
			{ path: 'multi.txt', offset: 3, limit: 2 },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('3: line3'));
		assert.ok(result.result?.includes('4: line4'));
		assert.ok(result.result?.includes('Use offset=5 to continue'));
	});

	it('同一轮重复读取未变化文件时复用已有结果', async () => {
		// Arrange
		await writeFile('reuse.txt', 'line1\nline2\n');
		const context = await makeContext({ sessionId: 'session-1', runId: 'run-1' });
		// Act
		const first = await tool.execute({ path: 'reuse.txt' }, context);
		const second = await tool.execute({ path: 'reuse.txt', offset: 1, limit: 2000 }, context);
		// Assert
		assert.strictEqual(first.status, 'success');
		assert.strictEqual(second.status, 'success');
		assert.strictEqual(second.metadata?.reused, true);
		assert.ok(second.result?.includes('已复用当前轮已读取内容'));
	});

	it('同一轮并发重复读取时仅有一个调用实际加载内容', async () => {
		// Arrange
		await writeFile('parallel-reuse.txt', 'line1\nline2\n');
		const context = await makeContext({ sessionId: 'session-1', runId: 'run-1' });
		// Act
		const results = await Promise.all([
			tool.execute({ path: 'parallel-reuse.txt' }, context),
			tool.execute({ path: 'parallel-reuse.txt' }, context),
		]);
		// Assert
		assert.strictEqual(results.filter((result) => result.metadata?.reused === true).length, 1);
		assert.strictEqual(results.filter((result) => result.result?.includes('1: line1')).length, 1);
	});

	it('不同分页区间必须读取新的文件内容', async () => {
		// Arrange
		await writeFile('ranges.txt', 'line1\nline2\nline3\nline4\n');
		const context = await makeContext({ sessionId: 'session-1', runId: 'run-1' });
		// Act
		await tool.execute({ path: 'ranges.txt', offset: 1, limit: 2 }, context);
		const result = await tool.execute({ path: 'ranges.txt', offset: 3, limit: 2 }, context);
		// Assert
		assert.strictEqual(result.metadata?.reused, undefined);
		assert.ok(result.result?.includes('3: line3'));
	});

	it('文件版本变化后必须重新读取', async () => {
		// Arrange
		await writeFile('changed.txt', 'before\n');
		const context = await makeContext({ sessionId: 'session-1', runId: 'run-1' });
		await tool.execute({ path: 'changed.txt' }, context);
		await writeFile('changed.txt', 'after changed\n');
		// Act
		const result = await tool.execute({ path: 'changed.txt' }, context);
		// Assert
		assert.strictEqual(result.metadata?.reused, undefined);
		assert.ok(result.result?.includes('after changed'));
	});

	it('readMaxLines 限制未显式指定 limit 的单页行数', async () => {
		// Arrange
		await writeFile('configured-limit.txt', 'line1\nline2\nline3\n');
		// Act
		const result = await tool.execute({ path: 'configured-limit.txt' }, await makeContext({ readMaxLines: 2 }));
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('1: line1'));
		assert.ok(result.result?.includes('2: line2'));
		assert.ok(!result.result?.includes('3: line3'));
	});

	it('分页读取按全局字符预算返回连续区间，不触发头尾裁剪', async () => {
		// Arrange
		await writeFile('continuous.txt', Array.from({ length: 20 }, (_, index) => `line-${index + 1}-${'x'.repeat(100)}`).join('\n'));
		const context = await makeContext({ toolResultLimit: 1000, readMaxBytes: 2000 });
		// Act
		const raw = await tool.execute({ path: 'continuous.txt' }, context);
		const result = tool.governResult(raw, context);
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('Output capped'));
		assert.ok(!result.result?.includes('结果已裁剪'));
	});

	it('默认 2000 行分页为包装信息预留行数，统一治理后仍保留连续结尾', async () => {
		// Arrange
		await writeFile('boundary.txt', Array.from({ length: 2000 }, (_, index) => `line-${index + 1}`).join('\n'));
		const context = await makeContext();
		// Act
		const raw = await tool.execute({ path: 'boundary.txt' }, context);
		const result = tool.governResult(raw, context);
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('1994: line-1994'));
		assert.ok(result.result?.includes('Use offset=1995 to continue'));
		assert.ok(result.result?.endsWith('</content>'));
		assert.ok(!result.result?.includes('结果行数已裁剪'));
	});

	it('字节预算截断：超过 readMaxBytes 停止并提示', async () => {
		// Arrange
		await writeFile('wide.txt', 'aaaa\nbbbb\ncccc\ndddd\n');
		// Act：预算 10 字节（约容纳 2 行），第 3 行时触发截断
		const result = await tool.execute({ path: 'wide.txt' }, await makeContext({ readMaxBytes: 10 }));
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('Output capped'));
		assert.ok(result.result?.includes('Use offset='));
		assert.strictEqual(result.metadata?.truncated, true);
	});

	it('单行截断：超过 readMaxLineLength 截断并标注', async () => {
		// Arrange
		await writeFile('longline.txt', 'x'.repeat(100) + '\nnext\n');
		// Act
		const result = await tool.execute({ path: 'longline.txt' }, await makeContext({ readMaxLineLength: 10 }));
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('line truncated'));
		assert.ok(result.result?.includes('2: next')); // 后续行不受影响
	});

	it('offset 越界返回 error（含总行数）', async () => {
		// Arrange
		await writeFile('small.txt', 'a\nb\nc\n');
		// Act
		const result = await tool.execute({ path: 'small.txt', offset: 100 }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('out of range'));
		assert.ok(result.error?.includes('100'));
	});

	it('空文件返回 End of file（非 error）', async () => {
		// Arrange
		await writeFile('empty.txt', '');
		// Act
		const result = await tool.execute({ path: 'empty.txt' }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('End of file'));
		assert.ok(result.result?.includes('total 0 lines'));
	});

	it('文件不以换行结尾时最后一行仍被读取', async () => {
		// Arrange
		await writeFile('nolf.txt', 'a\nb');
		// Act
		const result = await tool.execute({ path: 'nolf.txt' }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('2: b'));
		assert.ok(result.result?.includes('total 2 lines'));
	});

	it('offset 恰好等于总行数时返回最后一行', async () => {
		// Arrange
		await writeFile('exact.txt', 'a\nb\nc\n');
		// Act
		const result = await tool.execute({ path: 'exact.txt', offset: 3 }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('3: c'));
	});

	it('NUL 字节在 offset 之后仍判定为二进制', async () => {
		// Arrange
		await writeFile('nul2.txt', Buffer.from('a\nb\0c'));
		// Act：offset 2 本应读取 b\0c，但内容含 NUL 应整体拒绝
		const result = await tool.execute({ path: 'nul2.txt', offset: 2 }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('二进制文件'));
	});

	it('rejects a binary file by extension', async () => {
		// Arrange
		await writeFile('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		// Act
		const result = await tool.execute({ path: 'logo.png' }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('二进制文件'));
	});

	it('rejects a binary file by NUL byte in content', async () => {
		// Arrange
		await writeFile('data.txt', Buffer.from('hello\0world'));
		// Act
		const result = await tool.execute({ path: 'data.txt' }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('二进制文件'));
	});

	it('rejects a traversal path', async () => {
		// Arrange / Act
		const result = await tool.execute({ path: '../../../etc/passwd' }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('越界'));
	});

	it('redacts secrets in a sensitive .env file and warns', async () => {
		// Arrange
		await writeFile('.env', 'API_KEY=abc123def456\nname=app\n');
		const warnings: string[] = [];
		const ctx = await makeContext({ warn: (m) => warnings.push(m) });
		// Act
		const result = await tool.execute({ path: '.env' }, ctx);
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('API_KEY=***'));
		assert.ok(!result.result?.includes('abc123def456'));
		assert.ok(warnings.some((w) => w.includes('敏感文件')));
	});

	it('validate rejects empty path', () => {
		assert.throws(() => tool.validate({ path: '' }));
		assert.throws(() => tool.validate({}));
	});

	it('redactSecrets masks common secret patterns', () => {
		assert.ok(redactSecrets('token=abcdef1234567890').includes('token=***'));
		assert.ok(!redactSecrets('sk-' + 'a'.repeat(24)).includes('sk-'));
	});
});
