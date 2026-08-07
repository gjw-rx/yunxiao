/** 工作区级 Run 快照与连续事件游标存储。 */
export interface WorkspaceState {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

export type StoredRunStatus = 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';

export interface StoredRunEvent {
	readonly sequence: number | null;
	readonly type: string;
	readonly payload: unknown;
}

/** 云端确认的 Run 累计预算快照。 */
export interface RunBudgetSnapshot {
	readonly usage: Record<string, number>;
	readonly limits: Record<string, number>;
}

/** 供 Webview 恢复展示的轻量时间线条目。 */
export interface StoredTimelineEntry {
	readonly sequence: number;
	readonly type: 'content_batch' | 'budget_update' | 'budget_exhausted';
	readonly payload: unknown;
}

export interface StoredRun {
	readonly sessionId: string;
	readonly runId: string;
	readonly cursor: number;
	readonly status: StoredRunStatus;
	readonly workspaceRoots: readonly string[];
	readonly events: readonly StoredRunEvent[];
	readonly timeline: readonly StoredTimelineEntry[];
	readonly budget?: RunBudgetSnapshot;
}

export type AppendResult =
	| { readonly kind: 'appended'; readonly run: StoredRun }
	| { readonly kind: 'duplicate'; readonly run: StoredRun }
	| { readonly kind: 'gap'; readonly run: StoredRun; readonly expectedSequence: number };

const STATE_KEY = 'yunxiaoAgent.runStore.v1';
const TERMINAL_STATUSES = new Set<StoredRunStatus>(['completed', 'failed', 'cancelled', 'interrupted']);

/** 仅保存 UI 恢复所需的轻量 Run 状态，云端仍是事件事实来源。 */
export class RunStore {
	constructor(
		private readonly state: WorkspaceState,
		private readonly maxEvents = 100,
	) { }

	get(sessionId: string): StoredRun | undefined {
		const run = this.readAll()[sessionId];
		return run ? this.normalize(run) : undefined;
	}

	listRestorable(): StoredRun[] {
		return Object.values(this.readAll())
			.map((run) => this.normalize(run))
			.filter((run) => !TERMINAL_STATUSES.has(run.status));
	}

	async save(run: StoredRun): Promise<void> {
		const all = this.readAll();
		all[run.sessionId] = this.normalize(run);
		await this.state.update(STATE_KEY, all);
	}

	async remove(sessionId: string): Promise<void> {
		const all = this.readAll();
		delete all[sessionId];
		await this.state.update(STATE_KEY, all);
	}

	async append(sessionId: string, event: StoredRunEvent): Promise<AppendResult> {
		const run = this.get(sessionId);
		if (!run) {
			throw new Error(`未找到会话 ${sessionId} 的 Run 快照`);
		}
		// 瞬态事件（content chunk）sequence 为 null，跳过游标校验，不更新游标也不存储
		if (event.sequence === null) {
			return { kind: 'appended', run };
		}
		if (event.sequence <= run.cursor) {
			return { kind: 'duplicate', run };
		}
		const expectedSequence = run.cursor + 1;
		if (event.sequence !== expectedSequence) {
			return { kind: 'gap', run, expectedSequence };
		}
		const updated = this.normalize({
			...run,
			cursor: event.sequence,
			events: [...run.events, event],
			timeline: this.appendTimeline(run.timeline, event),
			budget: event.type === 'budget_update' ? parseBudget(event.payload) ?? run.budget : run.budget,
		});
		await this.save(updated);
		return { kind: 'appended', run: updated };
	}

	async updateStatus(sessionId: string, status: StoredRunStatus): Promise<StoredRun> {
		const run = this.get(sessionId);
		if (!run) {
			throw new Error(`未找到会话 ${sessionId} 的 Run 快照`);
		}
		const updated = { ...run, status };
		await this.save(updated);
		return updated;
	}

	private readAll(): Record<string, StoredRun> {
		return this.state.get<Record<string, StoredRun>>(STATE_KEY) ?? {};
	}

	private normalize(run: StoredRun): StoredRun {
		return {
			...run,
			workspaceRoots: [...run.workspaceRoots],
			events: run.events.slice(-this.maxEvents),
			timeline: (run.timeline ?? []).slice(-this.maxEvents),
		};
	}

	private appendTimeline(
		timeline: readonly StoredTimelineEntry[] | undefined,
		event: StoredRunEvent,
	): StoredTimelineEntry[] {
		if (!isTimelineEvent(event.type)) {
			return [...(timeline ?? [])];
		}
		// append 调用前已保证 event.sequence 非 null（瞬态事件在 append 入口提前返回）
		return [...(timeline ?? []), { sequence: event.sequence as number, type: event.type, payload: event.payload }];
	}
}

function isTimelineEvent(type: string): type is StoredTimelineEntry['type'] {
	return type === 'content_batch' || type === 'budget_update' || type === 'budget_exhausted';
}

function parseBudget(payload: unknown): RunBudgetSnapshot | undefined {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	const candidate = payload as { usage?: unknown; limits?: unknown };
	if (!isNumberRecord(candidate.usage) || !isNumberRecord(candidate.limits)) {
		return undefined;
	}
	return { usage: candidate.usage, limits: candidate.limits };
}

function isNumberRecord(value: unknown): value is Record<string, number> {
	if (!value || typeof value !== 'object') {
		return false;
	}
	return Object.values(value).every((item) => typeof item === 'number' && Number.isFinite(item));
}
