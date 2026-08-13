/** 会话代码变更日志单测。 */
import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import simpleGit from 'simple-git';
import { ChangeJournal } from '../../core/changeJournal';

describe('ChangeJournal', () => {
	let root: string;
	let workspace: string;
	let journal: ChangeJournal;

	/** 创建单测隔离目录与日志实例。 @returns 完成 Promise。 */
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-change-journal-'));
		workspace = path.join(root, 'workspace');
		await fs.mkdir(workspace);
		journal = new ChangeJournal(path.join(root, 'changes'));
	});

	/** 清理单测隔离目录。 @returns 完成 Promise。 */
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it('聚合同一回合对同一文件的多次写入', async () => {
		const file = path.join(workspace, 'a.ts');
		await fs.writeFile(file, 'before\n', 'utf8');
		const options = { sessionId: 's1', userSeq: 3, fsPath: file, relativePath: 'a.ts' };
		await journal.recordBefore(options);
		await fs.writeFile(file, 'middle\n', 'utf8');
		await journal.recordAfter(options);
		await journal.recordBefore(options);
		await fs.writeFile(file, 'after\n', 'utf8');
		await journal.recordAfter(options);

		const summary = await journal.finalize('s1', 3);
		assert.strictEqual(summary?.fileCount, 1);
		const detail = await journal.getFileDetail('s1', '3', '0');
		assert.strictEqual(detail?.before, 'before\n');
		assert.strictEqual(detail?.after, 'after\n');
	});

	it('回滚清理指定序号及之后的变更集', async () => {
		const file = path.join(workspace, 'a.ts');
		await fs.writeFile(file, 'before\n', 'utf8');
		for (const seq of [3, 5]) {
			const options = { sessionId: 's1', userSeq: seq, fsPath: file, relativePath: 'a.ts' };
			await journal.recordBefore(options);
			await fs.writeFile(file, `after-${seq}\n`, 'utf8');
			await journal.recordAfter(options);
			await journal.finalize('s1', seq);
		}

		await journal.clearAfterSeq('s1', 5);
		assert.ok(await journal.getSummary('s1', '3'));
		assert.strictEqual(await journal.getSummary('s1', '5'), undefined);
	});

	it('以会话基线累计终端等外部写入，并排除会话开始前已有内容', async () => {
		const existing = path.join(workspace, 'existing.ts');
		await fs.writeFile(existing, 'before-session\n', 'utf8');
		await journal.ensureSessionBaseline('s1', workspace);

		await fs.writeFile(path.join(workspace, 'created.md'), 'created\n', 'utf8');
		let summary = await journal.refreshSession('s1', workspace, 1);
		assert.strictEqual(summary?.id, 'session');
		assert.strictEqual(summary?.fileCount, 1);
		assert.strictEqual(summary?.files[0].relativePath, 'created.md');

		await fs.writeFile(existing, 'changed-in-session\n', 'utf8');
		summary = await journal.refreshSession('s1', workspace, 2);
		assert.strictEqual(summary?.fileCount, 2);
		const detail = await journal.getFileDetail('s1', 'session', '1');
		assert.strictEqual(detail?.relativePath, 'existing.ts');
		assert.strictEqual(detail?.before, 'before-session\n');
		assert.strictEqual(detail?.after, 'changed-in-session\n');
	});

	it('Git 工作区仅扫描已跟踪和未忽略文件', async () => {
		const git = simpleGit(workspace);
		await git.init();
		await fs.writeFile(path.join(workspace, '.gitignore'), 'ignored/\n', 'utf8');
		await fs.writeFile(path.join(workspace, 'tracked.ts'), 'before\n', 'utf8');
		await fs.mkdir(path.join(workspace, 'ignored'));
		await fs.writeFile(path.join(workspace, 'ignored', 'cache.txt'), 'before\n', 'utf8');
		await git.add(['.gitignore', 'tracked.ts']);
		await journal.ensureSessionBaseline('s1', workspace);

		await fs.writeFile(path.join(workspace, 'tracked.ts'), 'after\n', 'utf8');
		await fs.writeFile(path.join(workspace, 'ignored', 'cache.txt'), 'after\n', 'utf8');
		const summary = await journal.refreshSession('s1', workspace, 1);

		assert.deepStrictEqual(summary?.files.map((file) => file.relativePath), ['tracked.ts']);
	});
});
