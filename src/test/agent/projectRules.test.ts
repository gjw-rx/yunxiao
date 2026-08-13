/**
 * ProjectRules 测试 - 覆盖用户级全局 + 项目级 Agent 指令文件加载：优先级、拼接顺序、大小限制与失败降级。
 */
import * as assert from 'assert';
import { loadProjectRules } from '../../agent/projectRules';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('loadProjectRules', () => {
	let workspaceDir: string;
	let homeDir: string;

	beforeEach(async () => {
		workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-rules-ws-'));
		homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-rules-home-'));
	});

	afterEach(async () => {
		await fs.rm(workspaceDir, { recursive: true, force: true });
		await fs.rm(homeDir, { recursive: true, force: true });
	});

	it('项目级 CLAUDE.md 存在时优先使用且不读取项目级 AGENTS.md', async () => {
		await fs.writeFile(path.join(workspaceDir, 'CLAUDE.md'), '# CLAUDE 规范');
		await fs.writeFile(path.join(workspaceDir, 'AGENTS.md'), '# AGENTS 规范');
		const rules = await loadProjectRules(workspaceDir, { globalHomeDir: homeDir });
		assert.ok(rules);
		assert.deepStrictEqual(rules.sources, [path.join(workspaceDir, 'CLAUDE.md')]);
		assert.strictEqual(rules.content, '# CLAUDE 规范');
	});

	it('项目级仅存在 AGENTS.md 时回退使用', async () => {
		await fs.writeFile(path.join(workspaceDir, 'AGENTS.md'), '# AGENTS 规范');
		const rules = await loadProjectRules(workspaceDir, { globalHomeDir: homeDir });
		assert.ok(rules);
		assert.deepStrictEqual(rules.sources, [path.join(workspaceDir, 'AGENTS.md')]);
		assert.strictEqual(rules.content, '# AGENTS 规范');
	});

	it('用户级全局 AGENTS.md 存在时加载', async () => {
		const globalFile = path.join(homeDir, '.claude', 'AGENTS.md');
		await fs.mkdir(path.dirname(globalFile), { recursive: true });
		await fs.writeFile(globalFile, '# 全局 AGENTS 规范');
		const rules = await loadProjectRules(workspaceDir, { globalHomeDir: homeDir });
		assert.ok(rules);
		assert.deepStrictEqual(rules.sources, [globalFile]);
		assert.strictEqual(rules.content, '# 全局 AGENTS 规范');
	});

	it('用户级全局 AGENTS.md 不存在时回退全局 CLAUDE.md', async () => {
		const globalFile = path.join(homeDir, '.claude', 'CLAUDE.md');
		await fs.mkdir(path.dirname(globalFile), { recursive: true });
		await fs.writeFile(globalFile, '# 全局 CLAUDE 规范');
		const rules = await loadProjectRules(workspaceDir, { globalHomeDir: homeDir });
		assert.ok(rules);
		assert.deepStrictEqual(rules.sources, [globalFile]);
		assert.strictEqual(rules.content, '# 全局 CLAUDE 规范');
	});

	it('全局与项目同时存在时拼接且全局在前、项目在后', async () => {
		const globalFile = path.join(homeDir, '.claude', 'AGENTS.md');
		await fs.mkdir(path.dirname(globalFile), { recursive: true });
		await fs.writeFile(globalFile, '# 全局 AGENTS 规范');
		await fs.writeFile(path.join(workspaceDir, 'AGENTS.md'), '# 项目 AGENTS 规范');
		const rules = await loadProjectRules(workspaceDir, { globalHomeDir: homeDir });
		assert.ok(rules);
		assert.deepStrictEqual(rules.sources, [globalFile, path.join(workspaceDir, 'AGENTS.md')]);
		assert.strictEqual(rules.content, '# 全局 AGENTS 规范\n\n# 项目 AGENTS 规范');
	});

	it('全局 AGENTS.md 超限时跳过全局，项目级仍正常加载', async () => {
		const globalFile = path.join(homeDir, '.claude', 'AGENTS.md');
		await fs.mkdir(path.dirname(globalFile), { recursive: true });
		await fs.writeFile(globalFile, 'x'.repeat(64 * 1024 + 1));
		await fs.writeFile(path.join(workspaceDir, 'AGENTS.md'), '# 项目 AGENTS 规范');
		const rules = await loadProjectRules(workspaceDir, { globalHomeDir: homeDir });
		assert.ok(rules);
		assert.deepStrictEqual(rules.sources, [path.join(workspaceDir, 'AGENTS.md')]);
		assert.strictEqual(rules.content, '# 项目 AGENTS 规范');
	});

	it('全局与项目均不存在时返回 null', async () => {
		const rules = await loadProjectRules(workspaceDir, { globalHomeDir: homeDir });
		assert.strictEqual(rules, null);
	});

	it('空 workspaceRoot 返回 null', async () => {
		const rules = await loadProjectRules('', { globalHomeDir: homeDir });
		assert.strictEqual(rules, null);
	});
});
