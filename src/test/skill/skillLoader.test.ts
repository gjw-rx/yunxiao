/**
 * SkillLoader 测试 - 覆盖 frontmatter 解析，特别是 type 字段。
 */
import * as assert from 'assert';
import { parseFrontmatter, loadSkillsFromDirectory } from '../../skill/skillLoader';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('SkillLoader', () => {
	describe('parseFrontmatter type 解析', () => {
		it('type: agent 解析为 agent', () => {
			const raw = `---
name: my-agent
description: 子智能体示例
type: agent
---
正文`;
			const { frontmatter } = parseFrontmatter(raw);
			assert.ok(frontmatter);
			assert.strictEqual(frontmatter.type, 'agent');
		});

		it('type: skill 解析为 skill', () => {
			const raw = `---
name: my-skill
description: 普通 skill 示例
type: skill
---
正文`;
			const { frontmatter } = parseFrontmatter(raw);
			assert.ok(frontmatter);
			assert.strictEqual(frontmatter.type, 'skill');
		});

		it('缺省 type 为 undefined', () => {
			const raw = `---
name: plain
description: 无 type 字段
---
正文`;
			const { frontmatter } = parseFrontmatter(raw);
			assert.ok(frontmatter);
			assert.strictEqual(frontmatter.type, undefined);
		});
	});

	describe('loadSkillsFromDirectory type 落入 Skill', () => {
		let dir: string;

		beforeEach(async () => {
			dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-test-'));
			await fs.writeFile(
				path.join(dir, 'agent.md'),
				'---\nname: agent-a\ndescription: agent\ntype: agent\n---\nbody'
			);
			await fs.writeFile(
				path.join(dir, 'skill.md'),
				'---\nname: skill-a\ndescription: skill\n---\nbody'
			);
		});

		afterEach(async () => {
			await fs.rm(dir, { recursive: true, force: true });
		});

		it('type 正确落入 Skill 定义', async () => {
			const skills = await loadSkillsFromDirectory(dir);
			const agent = skills.find((s) => s.name === 'agent-a');
			const skill = skills.find((s) => s.name === 'skill-a');
			assert.strictEqual(agent?.type, 'agent');
			assert.strictEqual(skill?.type, undefined);
		});
	});
});
