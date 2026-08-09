import * as assert from 'assert';
import { BaseTool, type ToolContext, type ToolExecutionResult } from '../../tools/baseTool';
import type { ToolSchema } from '../../core/types';

class TestTool extends BaseTool {
	readonly schema: ToolSchema = { name: 'test.tool', description: 'test', parameters: {}, permissions: 'read' };
	async execute(): Promise<ToolExecutionResult> { return { status: 'success', result: 'ok' }; }
}

describe('BaseTool result governance', () => {
	it('脱敏 API key 并标记 metadata', () => {
		const result = new TestTool().governResult(
			{ status: 'success', result: 'API_KEY=super-secret-value' },
			{ workspaceRoots: [] }
		);
		assert.strictEqual(result.result, 'API_KEY=***');
		assert.strictEqual(result.metadata?.redacted, true);
	});

	it('裁剪大结果并保留标记', () => {
		const result = new TestTool().governResult(
			{ status: 'success', result: 'x'.repeat(100) },
			{ workspaceRoots: [], toolResultLimit: 32 }
		);
		assert.strictEqual(result.metadata?.truncated, true);
		assert.ok(result.result?.includes('结果已裁剪'));
	});

	it('二进制结果不回传原文', () => {
		const result = new TestTool().governResult(
			{ status: 'success', result: 'a\0b' },
			{ workspaceRoots: [] }
		);
		assert.strictEqual(result.result, '<binary content>');
	});

	it('行数超限裁剪并标记', () => {
		const result = new TestTool().governResult(
			{ status: 'success', result: Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') },
			{ workspaceRoots: [], governMaxLines: 3 }
		);
		assert.strictEqual(result.metadata?.truncated, true);
		assert.ok(result.result?.includes('行数已裁剪'));
	});

	it('字节超限裁剪并附续读指引', () => {
		const result = new TestTool().governResult(
			{ status: 'success', result: 'x'.repeat(100) },
			{ workspaceRoots: [], governMaxBytes: 10 }
		);
		assert.strictEqual(result.metadata?.truncated, true);
		assert.ok(result.result?.includes('字节数已裁剪'));
		assert.ok(result.result?.includes('offset'));
	});

	it('字符兜底（toolResultLimit）仍生效且附续读指引', () => {
		const result = new TestTool().governResult(
			{ status: 'success', result: 'y'.repeat(100) },
			{ workspaceRoots: [], toolResultLimit: 32 }
		);
		assert.strictEqual(result.metadata?.truncated, true);
		assert.ok(result.result?.includes('结果已裁剪'));
		assert.ok(result.result?.includes('offset'));
	});
});
