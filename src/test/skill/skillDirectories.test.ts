/**
 * SkillDirectories 测试 - 覆盖常驻默认加载（与来源解耦）与来源绑定目录的解析规则。
 */
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import { getResidentSkillDirs, getSourceSkillDirs } from '../../skill/skillDirectories';

describe('skillDirectories', () => {
	const workspaceRoot = 'C:\\fake-workspace';

	it('常驻目录与配置来源无关：项目 .claude/skills 在前、用户级 ~/.claude/skills 在后', () => {
		const dirs = getResidentSkillDirs(workspaceRoot);
		assert.deepStrictEqual(dirs, [
			path.join(workspaceRoot, '.claude', 'skills'),
			path.join(os.homedir(), '.claude', 'skills'),
		]);
	});

	it('none 来源时来源绑定目录仅含自定义 Skill 目录', () => {
		const dirs = getSourceSkillDirs(workspaceRoot, 'none', [path.join(workspaceRoot, '.vscode', 'skills')]);
		assert.deepStrictEqual(dirs, [path.join(workspaceRoot, '.vscode', 'skills')]);
	});

	it('claude 来源时来源绑定目录仅含自定义 Skill 目录（.claude/skills 已常驻）', () => {
		const dirs = getSourceSkillDirs(workspaceRoot, 'claude', [path.join(workspaceRoot, '.vscode', 'skills')]);
		assert.deepStrictEqual(dirs, [path.join(workspaceRoot, '.vscode', 'skills')]);
	});

	it('trae 来源时来源绑定目录追加用户级与项目级 Trae Skill 目录', () => {
		const dirs = getSourceSkillDirs(workspaceRoot, 'trae', [path.join(workspaceRoot, '.vscode', 'skills')]);
		assert.deepStrictEqual(dirs, [
			path.join(workspaceRoot, '.vscode', 'skills'),
			path.join(os.homedir(), '.trae', 'skills'),
			path.join(os.homedir(), '.trae-cn', 'skills'),
			path.join(workspaceRoot, '.trae', 'skills'),
			path.join(workspaceRoot, '.trae-cn', 'skills'),
		]);
	});

	it('切源场景：none 与 trae 的常驻目录保持一致（Claude Skill 保留），trae 追加 Trae 目录', () => {
		const configured = [path.join(workspaceRoot, '.vscode', 'skills')];
		assert.deepStrictEqual(getResidentSkillDirs(workspaceRoot), getResidentSkillDirs(workspaceRoot));
		const noneDirs = getSourceSkillDirs(workspaceRoot, 'none', configured);
		const traeDirs = getSourceSkillDirs(workspaceRoot, 'trae', configured);
		// none → trae 时，常驻目录不变（不被卸载），来源绑定目录仅追加 trae 部分
		assert.deepStrictEqual(noneDirs, configured);
		assert.strictEqual(traeDirs.length, noneDirs.length + 4);
	});
});
