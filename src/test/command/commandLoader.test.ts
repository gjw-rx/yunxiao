/**
 * Command 加载器测试 - 覆盖双作用域目录解析、目录缺失、无工作区、无效文件跳过与容错。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveCommandDirectories, loadCommandScope, loadCommandScopesFromDirs } from '../../command/commandLoader';

/**
 * 在临时目录下创建命令目录及文件。
 * @param dir 命令目录绝对路径
 * @param files 文件名→内容映射（如 review.md）
 */
function createCommandDir(dir: string, files: Record<string, string>): void {
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(dir, name), content, 'utf8');
	}
}

describe('resolveCommandDirectories', () => {
	it('全局目录为 ~/.yunForce/command，项目目录为第一个工作区根下的 .yunForce/command', () => {
		const dirs = resolveCommandDirectories(['/ws']);
		assert.ok(dirs.globalDir.endsWith('.yunForce\\command') || dirs.globalDir.endsWith('.yunForce/command'));
		assert.ok(dirs.projectDir?.endsWith('.yunForce\\command') || dirs.projectDir?.endsWith('.yunForce/command'));
		assert.ok(dirs.projectDir?.startsWith('/ws') || dirs.projectDir?.startsWith('\\ws'));
	});

	it('无工作区时 projectDir 为 undefined', () => {
		const dirs = resolveCommandDirectories([]);
		assert.ok(dirs.globalDir);
		assert.strictEqual(dirs.projectDir, undefined);
	});
});

describe('loadCommandScope', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-test-'));

	afterEach(() => {
		// 清理子目录内容
		for (const entry of fs.readdirSync(tmpDir)) {
			fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
		}
	});

	it('目录不存在返回空快照', async () => {
		const snap = await loadCommandScope('global', path.join(tmpDir, 'nonexistent'));
		assert.strictEqual(snap.commands.length, 0);
	});

	it('只加载 .md 文件，跳过非 .md 文件', async () => {
		createCommandDir(tmpDir, {
			'valid.md': '正文内容',
			'ignore.txt': '非 md 文件',
			'readme.md': '可读正文',
		});
		const snap = await loadCommandScope('global', tmpDir);
		assert.strictEqual(snap.commands.length, 2);
		assert.ok(snap.commands.some((c) => c.name === 'valid'));
		assert.ok(snap.commands.some((c) => c.name === 'readme'));
	});

	it('跳过非法名称的文件', async () => {
		createCommandDir(tmpDir, {
			'Uppercase.md': '正文内容', // 大写开头，非法
			'good.md': '正文内容',
			'a b.md': '正文内容', // 空白字符
		});
		const snap = await loadCommandScope('global', tmpDir);
		assert.strictEqual(snap.commands.length, 1);
		assert.strictEqual(snap.commands[0].name, 'good');
	});

	it('跳过正文为空的 .md 文件', async () => {
		createCommandDir(tmpDir, {
			'empty.md': '',
			'valid.md': '正文内容',
		});
		const snap = await loadCommandScope('global', tmpDir);
		assert.strictEqual(snap.commands.length, 1);
		assert.strictEqual(snap.commands[0].name, 'valid');
	});

	it('部分文件无效时有效文件仍被加载', async () => {
		createCommandDir(tmpDir, {
			'good.md': '有效正文',
			'bad.md': '---\ninvalid\n---\n\n', // 正文为空
			'also-good.md': '---\ndescription: 描述\n---\n正文',
		});
		const snap = await loadCommandScope('global', tmpDir);
		assert.strictEqual(snap.commands.length, 2);
	});

	it('命令按名称排序', async () => {
		createCommandDir(tmpDir, {
			'z.md': 'zzz',
			'a.md': 'aaa',
			'm.md': 'mmm',
		});
		const snap = await loadCommandScope('global', tmpDir);
		assert.deepStrictEqual(
			snap.commands.map((c) => c.name),
			['a', 'm', 'z'],
		);
	});
});

describe('loadCommandScopesFromDirs', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-dual-'));

	afterEach(() => {
		for (const entry of fs.readdirSync(tmpDir)) {
			fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
		}
	});

	it('全局与项目目录均存在时加载两个作用域', async () => {
		const globalDir = path.join(tmpDir, 'global', '.yunForce', 'command');
		const projectDir = path.join(tmpDir, 'project', '.yunForce', 'command');
		createCommandDir(globalDir, { 'g.md': '全局正文' });
		createCommandDir(projectDir, { 'p.md': '项目正文' });

		const result = await loadCommandScopesFromDirs({ globalDir, projectDir });
		assert.strictEqual(result.global.commands.length, 1);
		assert.strictEqual(result.global.commands[0].name, 'g');
		assert.ok(result.project);
		assert.strictEqual(result.project!.commands.length, 1);
		assert.strictEqual(result.project!.commands[0].name, 'p');
	});

	it('项目目录不存在时返回全局快照 + 项目为 null 的标记', async () => {
		const globalDir = path.join(tmpDir, 'global-only', '.yunForce', 'command');
		createCommandDir(globalDir, { 'g.md': '全局正文' });

		// 项目目录不存在场景模拟：使用不存在的目录，但 loadCommandScopesFromDirs
		// 本身不拼接空目录，需 caller 判断 projectDir 有无值
		const result = await loadCommandScopesFromDirs({ globalDir });
		assert.strictEqual(result.global.commands.length, 1);
		assert.strictEqual(result.project, null);
	});
});