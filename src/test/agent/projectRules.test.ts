/**
 * ProjectRules 测试 - 覆盖项目规范文件解析回退顺序与大小限制。
 */
import * as assert from 'assert';
import { loadAgentProjectRules, loadProjectRules } from '../../agent/projectRules';
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

describe('loadAgentProjectRules', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-rules-test-'));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('仅读取工作区根 AGENTS.md，与 CLAUDE.md 共存时不读取 CLAUDE.md', async () => {
		await fs.writeFile(path.join(dir, 'CLAUDE.md'), '# CLAUDE 规范');
		await fs.writeFile(path.join(dir, 'AGENTS.md'), '# AGENTS 规范');
		const rules = await loadAgentProjectRules(dir);
		assert.ok(rules);
		assert.strictEqual(rules.source, 'AGENTS.md');
		assert.strictEqual(rules.content, '# AGENTS 规范');
	});

	it('AGENTS.md 缺失时返回 null', async () => {
		const rules = await loadAgentProjectRules(dir);
		assert.strictEqual(rules, null);
	});

	it('AGENTS.md 超过大小上限时跳过注入返回 null', async () => {
		await fs.writeFile(path.join(dir, 'AGENTS.md'), 'x'.repeat(64 * 1024 + 10));
		const rules = await loadAgentProjectRules(dir);
		assert.strictEqual(rules, null);
	});

	it('AGENTS.md 读取失败（非文件）时降级返回 null', async () => {
		await fs.mkdir(path.join(dir, 'AGENTS.md'));
		const rules = await loadAgentProjectRules(dir);
		assert.strictEqual(rules, null);
	});

	it('不向子目录搜索 AGENTS.md', async () => {
		await fs.mkdir(path.join(dir, 'sub'));
		await fs.writeFile(path.join(dir, 'sub', 'AGENTS.md'), '# 子目录规则');
		const rules = await loadAgentProjectRules(dir);
		assert.strictEqual(rules, null, '子目录 AGENTS.md 不应被读取');
	});

	it('空 workspaceRoot 返回 null', async () => {
		const rules = await loadAgentProjectRules('');
		assert.strictEqual(rules, null);
	});
});
