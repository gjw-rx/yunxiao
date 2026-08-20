/**
 * Command 存储服务测试 - 覆盖全局/项目创建、编辑、删除、非法名称越界、无工作区禁用、
 * 部分无效文件容错与并发操作的串行一致性。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommandStore } from '../../command/commandStore';
import { CommandRegistry } from '../../command/commandRegistry';
import type { CommandDirectories } from '../../command/commandLoader';

/** 构造隔离的存储服务测试环境（临时目录 + 新注册表）。 */
function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-store-'));
	const globalDir = path.join(root, 'global', '.yunForce', 'command');
	const projectDir = path.join(root, 'project', '.yunForce', 'command');
	const dirs: CommandDirectories = { globalDir, projectDir };
	const registry = new CommandRegistry();
	const store = new CommandStore(dirs, registry);
	return { root, globalDir, projectDir, dirs, registry, store };
}

/** 读取文件内容（UTF-8）。 */
function readFile(filePath: string): string {
	return fs.readFileSync(filePath, 'utf8');
}

describe('CommandStore 创建', () => {
	it('创建全局 Command：写入 ~/.yunForce/command/<name>.md 并返回最新快照', async () => {
		const { store, globalDir } = setup();
		const snapshot = await store.create('global', { name: 'review', description: '审查改动', body: '请审查当前改动' });
		assert.ok(fs.existsSync(path.join(globalDir, 'review.md')), '应创建全局命令文件');
		assert.match(readFile(path.join(globalDir, 'review.md')), /description: 审查改动/);
		const loaded = snapshot.global.commands.find((c) => c.name === 'review');
		assert.ok(loaded);
		assert.strictEqual(loaded?.description, '审查改动');
		assert.strictEqual(loaded?.body, '请审查当前改动');
	});

	it('创建项目 Command：写入项目目录并返回快照', async () => {
		const { store, projectDir } = setup();
		const snapshot = await store.create('project', { name: 'review', body: '项目正文' });
		assert.ok(fs.existsSync(path.join(projectDir, 'review.md')));
		assert.strictEqual(snapshot.project?.commands[0]?.name, 'review');
	});

	it('目录不存在时按需创建目录', async () => {
		const { store, globalDir } = setup();
		assert.ok(!fs.existsSync(globalDir), '初始目录不存在');
		await store.create('global', { name: 'first', body: '首个命令' });
		assert.ok(fs.existsSync(globalDir), '创建后目录应被建立');
	});

	it('非法名称拒绝且不在作用域外创建文件', async () => {
		const { store, root } = setup();
		await assert.rejects(
			store.create('global', { name: '../../escape', body: 'x' }),
			/命令名不合法/,
		);
		await assert.rejects(
			store.create('global', { name: 'a/b', body: 'x' }),
			/命令名不合法/,
		);
		// 作用域目录及其外层不应出现任何新文件
		assert.ok(!fs.existsSync(path.join(root, 'global')), '非法名称不得创建目录或文件');
	});

	it('正文为空拒绝创建', async () => {
		const { store } = setup();
		await assert.rejects(store.create('global', { name: 'empty', body: '  ' }), /正文不能为空/);
	});
});

describe('CommandStore 编辑与删除', () => {
	it('编辑只更新目标文件的描述与正文', async () => {
		const { store, globalDir } = setup();
		await store.create('global', { name: 'review', description: '旧描述', body: '旧正文' });
		await store.update('global', 'review', { description: '新描述', body: '新正文' });
		const raw = readFile(path.join(globalDir, 'review.md'));
		assert.match(raw, /description: 新描述/);
		assert.match(raw, /新正文/);
		assert.ok(!raw.includes('旧正文'), '旧正文应被替换');
	});

	it('删除移除对应文件并从快照消失', async () => {
		const { store, globalDir, registry } = setup();
		await store.create('global', { name: 'review', body: 'x' });
		assert.ok(fs.existsSync(path.join(globalDir, 'review.md')));
		const snapshot = await store.delete('global', 'review');
		assert.ok(!fs.existsSync(path.join(globalDir, 'review.md')), '文件应被删除');
		assert.strictEqual(snapshot.global.commands.length, 0);
		assert.strictEqual(registry.get('review'), undefined);
	});

	it('删除不存在的命令返回中文错误', async () => {
		const { store } = setup();
		await assert.rejects(store.delete('global', 'missing'), /命令不存在/);
	});

	it('项目同名覆盖全局后，删除项目项恢复全局项生效', async () => {
		const { store, registry } = setup();
		await store.create('global', { name: 'review', body: '全局正文' });
		await store.create('project', { name: 'review', body: '项目正文' });
		assert.strictEqual(registry.get('review')?.body, '项目正文');
		await store.delete('project', 'review');
		assert.strictEqual(registry.get('review')?.body, '全局正文');
	});
});

describe('CommandStore 无工作区与容错', () => {
	it('无工作区（projectDir 缺省）时项目作用域写操作禁用', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-store-nws-'));
		const store = new CommandStore(
			{ globalDir: path.join(root, 'global', '.yunForce', 'command') },
			new CommandRegistry(),
		);
		await assert.rejects(store.create('project', { name: 'x', body: 'y' }), /未打开工作区/);
		await assert.rejects(store.update('project', 'x', { body: 'y' }), /未打开工作区/);
		await assert.rejects(store.delete('project', 'x'), /未打开工作区/);
		// 全局作用域仍可用
		const snapshot = await store.create('global', { name: 'g', body: '全局' });
		assert.strictEqual(snapshot.global.commands.length, 1);
	});

	it('部分无效文件存在时刷新仍成功且注册有效文件', async () => {
		const { store, globalDir } = setup();
		fs.mkdirSync(globalDir, { recursive: true });
		fs.writeFileSync(path.join(globalDir, 'good.md'), '有效正文', 'utf8');
		fs.writeFileSync(path.join(globalDir, 'bad.md'), '---\n未闭合', 'utf8');
		const snapshot = await store.refresh();
		assert.deepStrictEqual(
			snapshot.global.commands.map((c) => c.name),
			['good'],
		);
	});
});

describe('CommandStore 串行重载一致性', () => {
	it('并发创建多个 Command 后快照与注册表一致（顺序执行，不丢操作）', async () => {
		const { store, registry } = setup();
		await Promise.all([
			store.create('global', { name: 'a', body: 'A' }),
			store.create('global', { name: 'b', body: 'B' }),
			store.create('global', { name: 'c', body: 'C' }),
		]);
		assert.deepStrictEqual(
			registry.list().map((c) => c.name).sort(),
			['a', 'b', 'c'],
		);
		assert.strictEqual(store.getSnapshot().global.commands.length, 3);
	});

	it('并发删除与创建后最终快照反映串行执行结果', async () => {
		const { store, registry } = setup();
		await store.create('global', { name: 'keep', body: 'K' });
		await store.create('global', { name: 'drop', body: 'D' });
		await Promise.all([
			store.delete('global', 'drop'),
			store.create('global', { name: 'extra', body: 'E' }),
		]);
		const names = registry.list().map((c) => c.name).sort();
		assert.ok(names.includes('keep'));
		assert.ok(names.includes('extra'));
		assert.ok(!names.includes('drop'));
		// 物理快照与注册表一致
		assert.strictEqual(store.getSnapshot().global.commands.length, registry.list().length);
	});

	it('一次失败不污染后续串行操作', async () => {
		const { store, registry } = setup();
		await assert.rejects(store.create('global', { name: 'bad name', body: 'x' }), /命令名不合法/);
		const snapshot = await store.create('global', { name: 'good', body: 'y' });
		assert.strictEqual(snapshot.global.commands.length, 1);
		assert.strictEqual(registry.get('good')?.body, 'y');
	});
});
