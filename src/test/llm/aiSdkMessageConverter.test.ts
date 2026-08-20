/**
 * AI SDK 消息转换器测试 - 验证 LLMMessage → ModelMessage 转换。
 *
 * 覆盖：system / user / assistant（含 toolCalls）/ tool 四种消息类型，
 * 以及 arguments 非法 JSON 的兜底行为。
 */
import * as assert from 'assert';
import { convertToModelMessages } from '../../llm/aiSdkMessageConverter';
import type { LLMMessage } from '../../llm/types';

describe('convertToModelMessages', () => {
	it('system 消息转换为 AI SDK system 消息', () => {
		const messages: LLMMessage[] = [{ role: 'system', content: '你是助手' }];
		const converted = convertToModelMessages(messages);
		assert.strictEqual(converted[0].role, 'system');
		assert.strictEqual((converted[0] as { content: string }).content, '你是助手');
	});

	it('user 消息转换为 AI SDK user 消息', () => {
		const messages: LLMMessage[] = [{ role: 'user', content: '你好' }];
		const converted = convertToModelMessages(messages);
		assert.strictEqual(converted[0].role, 'user');
		assert.strictEqual((converted[0] as { content: string }).content, '你好');
	});

	it('无 toolCalls 的 assistant 消息为纯文本', () => {
		const messages: LLMMessage[] = [{ role: 'assistant', content: '答案' }];
		const converted = convertToModelMessages(messages);
		assert.strictEqual(converted[0].role, 'assistant');
		assert.strictEqual((converted[0] as { content: string }).content, '答案');
	});

	it('含 toolCalls 的 assistant 消息拆分为 text + tool-call parts', () => {
		const messages: LLMMessage[] = [
			{
				role: 'assistant',
				content: '读取文件',
				toolCalls: [{ id: 'call_1', name: 'fs_read_file', arguments: '{"path":"/tmp/a.ts"}' }],
			},
		];
		const converted = convertToModelMessages(messages);
		const assistant = converted[0] as { role: 'assistant'; content: Array<{ type: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown }> };
		assert.strictEqual(assistant.role, 'assistant');
		assert.ok(Array.isArray(assistant.content), '有 toolCalls 时 content 应为 parts 数组');
		assert.strictEqual(assistant.content[0].type, 'text');
		assert.strictEqual(assistant.content[0].text, '读取文件');
		assert.strictEqual(assistant.content[1].type, 'tool-call');
		assert.strictEqual(assistant.content[1].toolCallId, 'call_1');
		assert.strictEqual(assistant.content[1].toolName, 'fs_read_file');
		assert.deepStrictEqual(assistant.content[1].input, { path: '/tmp/a.ts' });
	});

	it('assistant 消息正文为空时只输出 tool-call parts', () => {
		const messages: LLMMessage[] = [
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: 'c', name: 'git_status', arguments: '{}' }],
			},
		];
		const converted = convertToModelMessages(messages);
		const parts = (converted[0] as { content: Array<{ type: string }> }).content;
		assert.strictEqual(parts.length, 1);
		assert.strictEqual(parts[0].type, 'tool-call');
	});

	it('tool 消息转换为 tool-result part', () => {
		const messages: LLMMessage[] = [{ role: 'tool', toolCallId: 'call_1', content: '文件内容' }];
		const converted = convertToModelMessages(messages);
		const toolMsg = converted[0] as { role: 'tool'; content: Array<{ type: string; toolCallId: string; output: unknown }> };
		assert.strictEqual(toolMsg.role, 'tool');
		assert.strictEqual(toolMsg.content[0].type, 'tool-result');
		assert.strictEqual(toolMsg.content[0].toolCallId, 'call_1');
		assert.deepStrictEqual(toolMsg.content[0].output, { type: 'text', value: '文件内容' });
	});

	it('tool 消息携带 toolName 时原样传给 tool-result part（Anthropic tool_result 校验需要）', () => {
		const messages: LLMMessage[] = [{ role: 'tool', toolCallId: 'call_1', content: '文件内容', toolName: 'fs_read_file' }];
		const converted = convertToModelMessages(messages);
		const toolMsg = converted[0] as { content: Array<{ toolName: string }> };
		assert.strictEqual(toolMsg.content[0].toolName, 'fs_read_file');
	});

	it('tool 消息缺失 toolName 时兜底为空串（兼容 OpenAI-compatible，忽略该字段）', () => {
		const messages: LLMMessage[] = [{ role: 'tool', toolCallId: 'call_1', content: '文件内容' }];
		const converted = convertToModelMessages(messages);
		const toolMsg = converted[0] as { content: Array<{ toolName: string }> };
		assert.strictEqual(toolMsg.content[0].toolName, '');
	});

	it('并行同名 tool call 的两个 tool result 各自携带独立调用 ID 与 toolName', () => {
		const assistant: LLMMessage = {
			role: 'assistant',
			content: '',
			toolCalls: [
				{ id: 'call_1', name: 'git_status', arguments: '{}' },
				{ id: 'call_2', name: 'git_status', arguments: '{}' },
			],
		};
		const results: LLMMessage[] = [
			{ role: 'tool', toolCallId: 'call_1', content: 'result1', toolName: 'git_status' },
			{ role: 'tool', toolCallId: 'call_2', content: 'result2', toolName: 'git_status' },
		];
		const converted = convertToModelMessages([assistant, ...results]);
		const first = converted[1] as { content: Array<{ toolCallId: string; toolName: string }> };
		const second = converted[2] as { content: Array<{ toolCallId: string; toolName: string }> };
		assert.strictEqual(first.content[0].toolCallId, 'call_1');
		assert.strictEqual(second.content[0].toolCallId, 'call_2');
		assert.strictEqual(first.content[0].toolName, 'git_status');
		assert.strictEqual(second.content[0].toolName, 'git_status');
	});

	it('tool call arguments 非法 JSON 时 input 兜底为空对象', () => {
		const messages: LLMMessage[] = [
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: 'c', name: 'read_file', arguments: '{bad json}' }],
			},
		];
		const converted = convertToModelMessages(messages);
		const parts = (converted[0] as { content: Array<{ input?: unknown }> }).content;
		assert.deepStrictEqual(parts[0].input, {});
	});
});
