import * as assert from 'assert';
import { SecurityAudit } from '../../core/securityAudit';
import { BaseTool, type ToolContext, type ToolExecutionResult } from '../../tools/baseTool';
import type { ToolCall, ToolSchema } from '../../core/types';

class ReadTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs.read_file', description: 'read', parameters: {}, permissions: 'read',
	};
	async execute(): Promise<ToolExecutionResult> { return { status: 'success', result: 'ok' }; }
}

const CTX: ToolContext = { workspaceRoots: [] };

describe('SecurityAudit', () => {
	it('拦截路径遍历', () => {
		const result = new SecurityAudit().audit({
			call_id: 'c1', tool: 'fs.read_file', args: { path: '../secret' },
		}, new ReadTool(), CTX);
		assert.strictEqual(result.allowed, false);
		assert.strictEqual(result.rejection?.status, 'error');
	});

	it('危险终端命令交由工具审批', () => {
		const call: ToolCall = { call_id: 'c2', tool: 'terminal.exec', args: { command: 'npm test; rm -rf /' } };
		const result = new SecurityAudit().audit(call, new ReadTool(), CTX);
		assert.strictEqual(result.allowed, true);
		assert.ok(result.warning?.includes('用户确认'));
	});

	it('敏感路径仅警告，由工具结果治理负责脱敏', () => {
		const result = new SecurityAudit().audit({
			call_id: 'c3', tool: 'fs.read_file', args: { path: '.env' },
		}, new ReadTool(), CTX);
		assert.strictEqual(result.allowed, true);
		assert.ok(result.warning?.includes('敏感'));
	});
});
