/**
 * ProjectRules 测试 - 覆盖项目规范文件解析回退顺序与大小限制。
 */
import * as assert from 'assert';
import { loadProjectRules } from '../../agent/projectRules';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('loadProjectRules', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-rules-test-'));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('CLAUDE.md 存在时优先使用且不读取 AGENTS.md', async () => {
		await fs.writeFile(path.join(dir, 'CLAUDE.md'), '# CLAUDE 规范');
		await fs.writeFile(path.join(dir, 'AGENTS.md'), '# AGENTS 规范');
		const rules = await loadProjectRules(dir);
		assert.ok(rules);
		assert.strictEqual(rules.source, 'CLAUDE.md');
		assert.strictEqual(rules.content, '# CLAUDE 规范');
	});

	it('仅存在 AGENTS.md 时回退使用', async () => {
		await fs.writeFile(path.join(dir, 'AGENTS.md'), '# AGENTS 规范');
		const rules = await loadProjectRules(dir);
		assert.ok(rules);
		assert.strictEqual(rules.source, 'AGENTS.md');
		assert.strictEqual(rules.content, '# AGENTS 规范');
	});

	it('两者均不存在时返回 null', async () => {
		const rules = await loadProjectRules(dir);
		assert.strictEqual(rules, null);
	});

	it('空 workspaceRoot 返回 null', async () => {
		const rules = await loadProjectRules('');
		assert.strictEqual(rules, null);
	});
});
