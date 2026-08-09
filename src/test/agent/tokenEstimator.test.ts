import * as assert from 'assert';
import { estimateText, estimateRequest } from '../../agent/tokenEstimator';
import type { LLMMessage, ToolDefinition } from '../../llm/types';

describe('tokenEstimator', () => {
	describe('estimateText', () => {
		it('按字符数/4 估算', () => {
			assert.strictEqual(estimateText('abcdefgh'), 2); // 8 / 4
			assert.strictEqual(estimateText('abc'), 1); // ceil(3/4)
			assert.strictEqual(estimateText(''), 0);
		});
	});

	describe('estimateRequest', () => {
		it('累加 system prompt + 消息 + 工具定义', () => {
			const messages: LLMMessage[] = [
				{ role: 'user', content: 'hello world' },
				{ role: 'assistant', content: 'hi there' },
				{ role: 'tool', toolCallId: 't1', content: 'result' },
			];
			const tools: ToolDefinition[] = [
				{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
			];
			const total = estimateRequest('sys', messages, tools);
			assert.ok(total > 0);
			assert.strictEqual(total, estimateText('sys') + estimateText('hello world') + estimateText('hi there') + estimateText('result') + estimateText('read_fileRead a file{"type":"object"}'));
		});

		it('无工具定义时不估算工具', () => {
			const messages: LLMMessage[] = [{ role: 'user', content: 'hi' }];
			const withTools = estimateRequest('sys', messages, [
				{ name: 'tool_x', description: 'desc', parameters: {} },
			]);
			const withoutTools = estimateRequest('sys', messages);
			assert.strictEqual(withTools, withoutTools + estimateText('tool_xdesc{}'));
		});

		it('assistant 消息包含 toolCalls 文本', () => {
			const messages: LLMMessage[] = [
				{ role: 'assistant', content: 'body', toolCalls: [{ id: '1', name: 'read_file', arguments: '{"path":"/a"}' }] },
			];
			const total = estimateRequest('sys', messages);
			assert.strictEqual(total, estimateText('sys') + estimateText('bodyread_file{"path":"/a"}'));
		});
	});
});
