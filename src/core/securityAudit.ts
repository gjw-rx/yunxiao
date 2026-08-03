/** 本地工具执行前的统一安全审计。路径最终解析仍由 pathGuard 负责。 */
import type { ToolCall, ToolResult } from './types';
import type { BaseTool, ToolContext } from '../tools/baseTool';
import { isSensitivePath } from '../tools/fs/pathGuard';
import { ReliabilityMetrics } from './reliabilityMetrics';

export interface SecurityAuditResult {
	readonly allowed: boolean;
	readonly warning?: string;
	readonly rejection?: ToolResult;
}

const DANGEROUS_COMMAND = /(?:\brm\s+-[a-z]*r[a-z]*f\b|\brmdir\s+\/s\b|\bsudo\b|\bmkfs\b|\bdd\s+if=|\bgit\s+reset\s+--hard\b|[;&]|\|\|?|>>?)/i;

export class SecurityAudit {
	constructor(private readonly metrics = new ReliabilityMetrics()) {}

	audit(call: ToolCall, tool: BaseTool, _context: ToolContext): SecurityAuditResult {
		for (const key of ['path', 'from', 'to', 'cwd']) {
			const value = call.args[key];
			if (typeof value === 'string' && containsTraversal(value)) {
			return this.reject(call.call_id, '路径越界，已被安全审计拦截');
			}
		}

		if (call.tool === 'terminal.exec' && typeof call.args.command === 'string' && DANGEROUS_COMMAND.test(call.args.command)) {
			this.metrics.record('audit_rejected');
			return {
				allowed: false,
				rejection: { call_id: call.call_id, status: 'cancelled', error: '危险命令已被拦截（安全审计）' },
			};
		}

		for (const key of ['path', 'from', 'to']) {
			const value = call.args[key];
			if (typeof value === 'string' && isSensitivePath(value)) {
				this.metrics.record('audit_sensitive_warning');
				return { allowed: true, warning: `正在访问敏感路径: ${value}` };
			}
		}

		this.metrics.record('audit_allowed');
		return { allowed: true };
	}

	private reject(callId: string, error: string): SecurityAuditResult {
		this.metrics.record('audit_rejected');
		return { allowed: false, rejection: { call_id: callId, status: 'error', error } };
	}
}

function containsTraversal(input: string): boolean {
	return input.replace(/\\/g, '/').split('/').includes('..');
}
