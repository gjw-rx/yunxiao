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

	it('returns error when file exceeds size limit', async () => {
		// Arrange
		await writeFile('big.txt', 'x'.repeat(100));
		// Act
		const result = await tool.execute({ path: 'big.txt' }, await makeContext({ maxFileSize: 10 }));
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('大小上限'));
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
