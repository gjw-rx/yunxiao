/**
 * Command 解析器测试 - 覆盖命令名校验与 Markdown 内容解析（可选 description、非法名称、空正文、非法 frontmatter）。
 */
import * as assert from 'assert';
import { isValidCommandName, parseCommandContent } from '../../command/commandParser';

describe('isValidCommandName', () => {
	it('小写字母或数字开头且仅含小写字母、数字、-、_ 的合法名称', () => {
		assert.ok(isValidCommandName('review'));
		assert.ok(isValidCommandName('plan3'));
		assert.ok(isValidCommandName('1st-draft'));
		assert.ok(isValidCommandName('a_b-c2'));
	});

	it('空字符串、大写字母、特殊字符、点号与路径分隔符均不合法', () => {
		assert.ok(!isValidCommandName(''));
		assert.ok(!isValidCommandName('Review'));
		assert.ok(!isValidCommandName('my command'));
		assert.ok(!isValidCommandName('a.b'));
		assert.ok(!isValidCommandName('a/b'));
		assert.ok(!isValidCommandName('..'));
		assert.ok(!isValidCommandName('-abc'));
		assert.ok(!isValidCommandName('_abc'));
	});
});

describe('parseCommandContent', () => {
	it('无 frontmatter 时正文即全文（去首尾空白）', () => {
		const result = parseCommandContent('review', '  请审查当前改动  \n');
		assert.ok(result);
		assert.strictEqual(result?.description, undefined);
		assert.strictEqual(result?.body, '请审查当前改动');
	});

	it('带 description frontmatter 时解析描述与正文', () => {
		const raw = `---
description: 审查当前改动并给出风险清单
---
请审查当前改动，按严重级别列出问题。`;
		const result = parseCommandContent('review', raw);
		assert.ok(result);
		assert.strictEqual(result?.description, '审查当前改动并给出风险清单');
		assert.strictEqual(result?.body, '请审查当前改动，按严重级别列出问题。');
	});

	it('frontmatter 中 description 缺省时描述为空', () => {
		const raw = `---
someOther: 忽略
---
正文内容`;
		const result = parseCommandContent('review', raw);
		assert.ok(result);
		assert.strictEqual(result?.description, undefined);
		assert.strictEqual(result?.body, '正文内容');
	});

	it('正文为空（含仅空白）时解析失败', () => {
		assert.strictEqual(parseCommandContent('empty', ''), null);
		assert.strictEqual(parseCommandContent('empty', '   \n  '), null);
		assert.strictEqual(parseCommandContent('empty', '---\ndescription: x\n---\n  '), null);
	});

	it('frontmatter 未闭合（格式无效）时解析失败', () => {
		const raw = '---\ndescription: 未闭合\n正文';
		assert.strictEqual(parseCommandContent('broken', raw), null);
	});

	it('正文包含代码块仅作为原文，不做任何执行', () => {
		const raw = '```bash\nrm -rf /\n```\n请执行上述命令';
		const result = parseCommandContent('danger', raw);
		assert.ok(result);
		assert.strictEqual(result?.body, '```bash\nrm -rf /\n```\n请执行上述命令');
	});
});
