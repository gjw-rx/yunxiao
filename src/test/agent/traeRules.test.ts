/**
 * TraeRules 测试 - 覆盖 Trae 规则递归扫描、拼接、深度限制与大小上限。
 */
import * as assert from 'assert';
import { loadTraeRules } from '../../agent/traeRules';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('loadTraeRules', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trae-rules-test-'));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('扫描 .trae/rules 与 .trae-cn/rules 拼接规则并标注来源', async () => {
		await fs.mkdir(path.join(dir, '.trae', 'rules'), { recursive: true });
		await fs.writeFile(path.join(dir, '.trae', 'rules', 'project_rules.md'), '# 规则A');
		await fs.mkdir(path.join(dir, '.trae-cn', 'rules', 'sub'), { recursive: true });
		await fs.writeFile(path.join(dir, '.trae-cn', 'rules', 'sub', 'git.md'), '# 规则B');

		const rules = await loadTraeRules(dir);
		assert.ok(rules);
		assert.strictEqual(rules.sources.length, 2);
		assert.ok(rules.sources.includes(path.join('.trae', 'rules', 'project_rules.md')));
		assert.ok(rules.sources.includes(path.join('.trae-cn', 'rules', 'sub', 'git.md')));
		assert.ok(rules.content.includes('# 规则A'));
		assert.ok(rules.content.includes('# 规则B'));
		assert.ok(rules.content.includes('## 来源:'));
	});

	it('目录均不存在时返回 null', async () => {
		const rules = await loadTraeRules(dir);
		assert.strictEqual(rules, null);
	});

	it('空 workspaceRoot 返回 null', async () => {
		const rules = await loadTraeRules('');
		assert.strictEqual(rules, null);
	});

	it('递归深度限制为 3 层', async () => {
		await fs.mkdir(path.join(dir, '.trae', 'rules', 'a', 'b', 'c'), { recursive: true });
		await fs.writeFile(path.join(dir, '.trae', 'rules', 'a', 'b', 'file.md'), '# 深度2');
		await fs.writeFile(path.join(dir, '.trae', 'rules', 'a', 'b', 'c', 'file.md'), '# 深度3');

		const rules = await loadTraeRules(dir);
		assert.ok(rules);
		assert.strictEqual(rules.sources.length, 1, '3 层及以上子目录不应被扫描');
		assert.ok(rules.content.includes('# 深度2'));
		assert.ok(!rules.content.includes('# 深度3'));
	});

	it('规则合计超过大小上限时跳过注入', async () => {
		await fs.mkdir(path.join(dir, '.trae', 'rules'), { recursive: true });
		await fs.writeFile(path.join(dir, '.trae', 'rules', 'big.md'), 'x'.repeat(64 * 1024 + 10));

		const rules = await loadTraeRules(dir);
		assert.strictEqual(rules, null);
	});

	it('单文件读取失败时跳过该文件，其余正常加载', async () => {
		await fs.mkdir(path.join(dir, '.trae', 'rules'), { recursive: true });
		// 用目录冒充 .md 文件，readFile 会失败
		await fs.mkdir(path.join(dir, '.trae', 'rules', 'bad.md'));
		await fs.writeFile(path.join(dir, '.trae', 'rules', 'good.md'), '# 正常规则');

		const rules = await loadTraeRules(dir);
		assert.ok(rules);
		assert.strictEqual(rules.sources.length, 1);
		assert.ok(rules.content.includes('# 正常规则'));
	});
});
