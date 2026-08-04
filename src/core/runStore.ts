/** 工作区级 Run 快照与连续事件游标存储。 */
export interface WorkspaceState {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

export type StoredRunStatus = 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';

export interface StoredRunEvent {
	readonly sequence: number;
	readonly type: string;
	readonly payload: unknown;
}

export interface StoredRun {
	readonly sessionId: string;
	readonly runId: string;
	readonly cursor: number;
	readonly status: StoredRunStatus;
	readonly workspaceRoots: readonly string[];
	readonly events: readonly StoredRunEvent[];
}

export type AppendResult =
	| { readonly kind: 'appended'; readonly run: StoredRun }
	| { readonly kind: 'duplicate'; readonly run: StoredRun }
	| { readonly kind: 'gap'; readonly run: StoredRun; readonly expectedSequence: number };

const STATE_KEY = 'yunxiaoAgent.runStore.v1';
const TERMINAL_STATUSES = new Set<StoredRunStatus>(['completed', 'failed', 'cancelled']);

/** 仅保存 UI 恢复所需的轻量 Run 状态，云端仍是事件事实来源。 */
export class RunStore {
	constructor(
		private readonly state: WorkspaceState,
		private readonly maxEvents = 100,
	) {}

	get(sessionId: string): StoredRun | undefined {
		return this.readAll()[sessionId];
	}

	listRestorable(): StoredRun[] {
		return Object.values(this.readAll()).filter((run) => !TERMINAL_STATUSES.has(run.status));
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
		};
	}
}
