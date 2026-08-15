/**
 * RollbackJournal 单测：回滚快照的记录、按 turn 恢复与清理。
 * 使用临时目录隔离，覆盖覆盖写入、新建、删除、目录、多 turn 与清理场景。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RollbackJournal } from '../../core/rollbackJournal';

/** 创建临时根目录。 @returns 临时目录绝对路径。 */
async function makeTempDir(): Promise<string> {
	return fs.promises.mkdtemp(path.join(os.tmpdir(), 'rollback-journal-'));
}

describe('RollbackJournal', () => {
	let root: string;
	let workspace: string;
	let journal: RollbackJournal;

	beforeEach(async () => {
		root = await makeTempDir();
		workspace = path.join(root, 'ws');
		await fs.promises.mkdir(workspace, { recursive: true });
		journal = new RollbackJournal(path.join(root, 'rollback'));
	});

	afterEach(async () => {
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	/** 写入工作区文件（自动建父目录）。 */
	async function writeFile(rel: string, content: string): Promise<void> {
		const p = path.join(workspace, rel);
		await fs.promises.mkdir(path.dirname(p), { recursive: true });
		await fs.promises.writeFile(p, content, 'utf8');
	}

	/** 读取工作区文件内容。 */
	async function readFile(rel: string): Promise<string> {
		return fs.promises.readFile(path.join(workspace, rel), 'utf8');
	}

	it('覆盖写入：回滚恢复到改动前内容', async () => {
		await writeFile('a.ts', 'v1');
		await journal.record({
			sessionId: 's1', userSeq: 0, fsPath: path.join(workspace, 'a.ts'), relativePath: 'a.ts', existedBefore: true,
		});
		await writeFile('a.ts', 'v2');
		await journal.restoreTurn('s1', 0, workspace);
		assert.strictEqual(await readFile('a.ts'), 'v1');
	});

	it('新建文件：回滚时删除', async () => {
		await journal.record({
			sessionId: 's1', userSeq: 0, fsPath: path.join(workspace, 'b.ts'), relativePath: 'b.ts', existedBefore: false,
		});
		await writeFile('b.ts', 'new');
		await journal.restoreTurn('s1', 0, workspace);
		await assert.rejects(fs.promises.stat(path.join(workspace, 'b.ts')));
	});

	it('删除文件：回滚时恢复', async () => {
		await writeFile('c.ts', 'keep');
		await journal.record({
			sessionId: 's1', userSeq: 0, fsPath: path.join(workspace, 'c.ts'), relativePath: 'c.ts', existedBefore: true,
		});
		await fs.promises.rm(path.join(workspace, 'c.ts'));
		await journal.restoreTurn('s1', 0, workspace);
		assert.strictEqual(await readFile('c.ts'), 'keep');
	});

	it('目录：回滚时整目录恢复', async () => {
		const dir = path.join(workspace, 'lib');
		await fs.promises.mkdir(path.join(dir, 'sub'), { recursive: true });
		await fs.promises.writeFile(path.join(dir, 'sub', 'x.ts'), 'x');
		await journal.record({
			sessionId: 's1', userSeq: 0, fsPath: dir, relativePath: 'lib', existedBefore: true,
		});
		await fs.promises.rm(dir, { recursive: true, force: true });
		await journal.restoreTurn('s1', 0, workspace);
		assert.strictEqual(await fs.promises.readFile(path.join(workspace, 'lib', 'sub', 'x.ts'), 'utf8'), 'x');
	});

	it('同一 turn 重复改动同一文件保留首次状态', async () => {
		await writeFile('a.ts', 'v0');
		await journal.record({
			sessionId: 's1', userSeq: 0, fsPath: path.join(workspace, 'a.ts'), relativePath: 'a.ts', existedBefore: true,
		});
		await writeFile('a.ts', 'v1');
		await journal.record({
			sessionId: 's1', userSeq: 0, fsPath: path.join(workspace, 'a.ts'), relativePath: 'a.ts', existedBefore: true,
		});
		await writeFile('a.ts', 'v2');
		await journal.restoreTurn('s1', 0, workspace);
		assert.strictEqual(await readFile('a.ts'), 'v0');
	});

	it('多 turn：回滚时取 userSeq 最小的 before 状态', async () => {
		await writeFile('a.ts', 'base');
		await journal.record({
			sessionId: 's1', userSeq: 0, fsPath: path.join(workspace, 'a.ts'), relativePath: 'a.ts', existedBefore: true,
		});
		await writeFile('a.ts', 'turn0');
		await journal.record({
			sessionId: 's1', userSeq: 5, fsPath: path.join(workspace, 'a.ts'), relativePath: 'a.ts', existedBefore: true,
		});
		await writeFile('a.ts', 'turn5');
		await journal.restoreTurn('s1', 0, workspace);
		assert.strictEqual(await readFile('a.ts'), 'base');
	});

	it('clearAfterSeq 清理指定 turn 及之后快照', async () => {
		await writeFile('a.ts', 'a');
		await journal.record({
			sessionId: 's1', userSeq: 0, fsPath: path.join(workspace, 'a.ts'), relativePath: 'a.ts', existedBefore: true,
		});
		await journal.record({
			sessionId: 's1', userSeq: 5, fsPath: path.join(workspace, 'a.ts'), relativePath: 'a.ts', existedBefore: true,
		});
		await journal.clearAfterSeq('s1', 5);
		const dirs = await fs.promises.readdir(path.join(root, 'rollback', 's1'));
		assert.deepStrictEqual(dirs, ['0']);
	});

	it('clearSession 清理会话全部快照且不影响其他会话', async () => {
		await journal.record({
			sessionId: 's1', userSeq: 0, fsPath: path.join(workspace, 'a.ts'), relativePath: 'a.ts', existedBefore: true,
		});
		await journal.record({
			sessionId: 's2', userSeq: 0, fsPath: path.join(workspace, 'a.ts'), relativePath: 'a.ts', existedBefore: true,
		});
		await journal.clearSession('s1');
		await assert.rejects(fs.promises.stat(path.join(root, 'rollback', 's1')));
		assert.ok((await fs.promises.readdir(path.join(root, 'rollback'))).includes('s2'));
	});

	it('无可恢复快照时返回 0', async () => {
		const count = await journal.restoreTurn('s1', 0, workspace);
		assert.strictEqual(count, 0);
	});
});
