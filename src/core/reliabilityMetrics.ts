/** 本地 Phase6 安全与可靠性指标。只记录计数和事件名，不记录工具输出或敏感参数。 */
import * as logger from '../logger';

export type ReliabilityMetric =
	| 'audit_allowed'
	| 'audit_rejected'
	| 'audit_sensitive_warning'
	| 'tool_cancelled'
	| 'tool_timeout'
	| 'duplicate_result_ignored'
	| 'parallel_tool_batch';

export class ReliabilityMetrics {
	private readonly counters = new Map<ReliabilityMetric, number>();

	record(metric: ReliabilityMetric): void {
		const value = (this.counters.get(metric) ?? 0) + 1;
		this.counters.set(metric, value);
		logger.log(`# [ReliabilityMetrics] ${metric}=${value}`);
	}

	snapshot(): Readonly<Record<ReliabilityMetric, number>> {
		return {
			audit_allowed: this.counters.get('audit_allowed') ?? 0,
			audit_rejected: this.counters.get('audit_rejected') ?? 0,
			audit_sensitive_warning: this.counters.get('audit_sensitive_warning') ?? 0,
			tool_cancelled: this.counters.get('tool_cancelled') ?? 0,
			tool_timeout: this.counters.get('tool_timeout') ?? 0,
			duplicate_result_ignored: this.counters.get('duplicate_result_ignored') ?? 0,
			parallel_tool_batch: this.counters.get('parallel_tool_batch') ?? 0,
		};
	}
}
