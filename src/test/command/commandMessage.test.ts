/**
 * Command 消息展开测试 - 覆盖正文/补充说明按边界拼接、空补充省略、文件/Skill 块插入顺序。
 */
import * as assert from 'assert';
import { buildCommandMessage } from '../../command/commandMessage';
import type { Command } from '../../command/types';

const COMMAND: Command = {
	name: 'review',
	body: '请审查当前改动',
	scope: 'global',
	sourcePath: '/ws/review.md',
};

describe('buildCommandMessage', () => {
	it('含补充说明：Command 块与补充说明区块按边界拼接', () => {
		const text = buildCommandMessage({ command: COMMAND, userText: '重点检查并发问题' });
		assert.strictEqual(text, '[Command: review]\n请审查当前改动\n\n[用户补充说明]\n重点检查并发问题');
	});

	it('补充文本为空：省略补充说明区块', () => {
		const text = buildCommandMessage({ command: COMMAND, userText: '' });
		assert.strictEqual(text, '[Command: review]\n请审查当前改动');
	});

	it('文件上下文位于 Command 块之前', () => {
		const text = buildCommandMessage({ command: COMMAND, userText: '', fileContext: '文件内容：xxx' });
		assert.strictEqual(text, '文件内容：xxx\n\n[Command: review]\n请审查当前改动');
	});

	it('Skill 块位于 Command 块与补充说明之间', () => {
		const text = buildCommandMessage({
			command: COMMAND,
			userText: '补充',
			skillBlock: '/plan',
		});
		assert.strictEqual(text, '[Command: review]\n请审查当前改动\n\n/plan\n\n[用户补充说明]\n补充');
	});
});
