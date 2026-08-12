/**
 * SkillInstaller 测试 - 覆盖安装目标、无工作区拒绝、不安全名称拒绝与内容校验。
 */
import * as assert from 'assert';
import AdmZip from 'adm-zip';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { installProjectSkill, installSkillArchive, validateSkillName } from '../../skill/skillInstaller';
import { loadSkillsFromDirectory } from '../../skill/skillLoader';

describe('SkillInstaller', () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-skill-install-'));
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('安装有效 Skill 写入 .claude/skills/<name>/SKILL.md', async () => {
		const content = '---\nname: my-skill\ndescription: 测试\n---\n正文';
		const result = await installProjectSkill('my-skill', content, [workspace]);

		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.filePath, path.join(workspace, '.claude', 'skills', 'my-skill', 'SKILL.md'));
			const written = await fs.readFile(result.filePath, 'utf8');
			assert.strictEqual(written, content);
		}
	});

	it('未打开工作区时拒绝安装并返回明确原因', async () => {
		const result = await installProjectSkill('my-skill', 'content', []);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.reason.includes('未打开工作区'));
		}
	});

	it('拒绝不安全名称（路径分隔符 / .. / 非法字符）', async () => {
		const cases = ['../evil', 'a/b', 'a\\b', '..', 'has space', '中文名', 'a..b', 'a/b/c'];
		for (const name of cases) {
			assert.ok(validateSkillName(name), `名称 ${name} 应被判定为不安全`);
		}
	});

	it('拒绝空名称与超长名称', () => {
		assert.ok(validateSkillName(''));
		assert.ok(validateSkillName('   '));
		assert.ok(validateSkillName('x'.repeat(65)));
	});

	it('不安全名称不写入任何文件', async () => {
		const result = await installProjectSkill('../evil', 'content', [workspace]);
		assert.strictEqual(result.ok, false);
		const entries = await fs.readdir(workspace);
		assert.strictEqual(entries.length, 0, '不应在根目录创建任何内容');
	});

	it('拒绝空内容', async () => {
		const result = await installProjectSkill('my-skill', '   ', [workspace]);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.reason.includes('内容'));
		}
	});

	it('合法名称通过校验', () => {
		assert.strictEqual(validateSkillName('my-skill'), null);
		assert.strictEqual(validateSkillName('Plan_2026'), null);
		assert.strictEqual(validateSkillName('a1B2'), null);
	});

	it('安装后可从项目 .claude/skills 目录重新加载（安装→刷新闭环）', async () => {
		const content = '---\nname: installed-skill\ndescription: 安装后加载\n---\n正文';
		const result = await installProjectSkill('installed-skill', content, [workspace]);
		assert.strictEqual(result.ok, true);

		// 重新加载项目 Claude Skill 目录（模拟 extension 安装后的 syncSkills 刷新路径）
		const loaded = await loadSkillsFromDirectory(path.join(workspace, '.claude', 'skills'));
		const skill = loaded.find((s) => s.name === 'installed-skill');
		assert.ok(skill, '安装的 Skill 应能被重新加载');
		assert.strictEqual(skill?.content, '正文');
		assert.strictEqual(skill?.sourcePath, path.join(workspace, '.claude', 'skills', 'installed-skill', 'SKILL.md'));
	});
 	it('安装合法 ZIP：解析根目录或一层目录内的 SKILL.md，并保留 Skill 资源文件', async () => {
		const archive = new AdmZip();
		archive.addFile('zip-skill/SKILL.md', Buffer.from('---\nname: zip-skill\ndescription: ZIP 安装测试\n---\n正文'));
		archive.addFile('zip-skill/references/guide.md', Buffer.from('资源正文'));
		const archivePath = path.join(workspace, 'zip-skill.zip');
		archive.writeZip(archivePath);

		const result = await installSkillArchive(archivePath, [workspace]);
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.name, 'zip-skill');
			assert.strictEqual(await fs.readFile(path.join(workspace, '.claude', 'skills', 'zip-skill', 'references', 'guide.md'), 'utf8'), '资源正文');
		}
	});

	it('拒绝不含符合协议 frontmatter 的 SKILL.md，且不创建安装目录', async () => {
		const archive = new AdmZip();
		archive.addFile('SKILL.md', Buffer.from('没有 frontmatter'));
		const archivePath = path.join(workspace, 'invalid-skill.zip');
		archive.writeZip(archivePath);

		const result = await installSkillArchive(archivePath, [workspace]);
		assert.strictEqual(result.ok, false);
		assert.strictEqual(await fs.stat(path.join(workspace, '.claude', 'skills')).then(() => true, () => false), false);
	});

	it('拒绝包含 Skill 根目录外文件的 ZIP，且不创建安装目录', async () => {
		const archive = new AdmZip();
		archive.addFile('safe-skill/SKILL.md', Buffer.from('---\nname: safe-skill\ndescription: 测试\n---\n正文'));
		archive.addFile('unexpected.txt', Buffer.from('bad'));
		const archivePath = path.join(workspace, 'unsafe-skill.zip');
		archive.writeZip(archivePath);

		const result = await installSkillArchive(archivePath, [workspace]);
		assert.strictEqual(result.ok, false);
		assert.strictEqual(await fs.stat(path.join(workspace, '.claude', 'skills', 'safe-skill')).then(() => true, () => false), false);
	});
});
