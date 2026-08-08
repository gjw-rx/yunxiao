/** 非幂等本地工具的持久化执行回执。 */
import type { ToolResult } from './types';

/** workspaceState 接口（与 vscode.Memento 兼容）。 */
export interface WorkspaceState {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

export interface ToolExecutionIdentity {
	readonly scopeId: string;
	readonly callId: string;
}

interface ReceiptBase {
	readonly scopeId: string;
	readonly callId: string;
	readonly tool: string;
}

interface StartedReceipt extends ReceiptBase {
	readonly state: 'started';
}

interface CompletedReceipt extends ReceiptBase {
	readonly state: 'completed';
	readonly result: ToolResult;
}

type Receipt = StartedReceipt | CompletedReceipt;

export type BeginResult =
	| { readonly kind: 'started' }
	| { readonly kind: 'unknown' }
	| { readonly kind: 'completed'; readonly result: ToolResult };

const STATE_KEY = 'yunxiaoAgent.toolExecutionJournal.v1';

/** 仅记录副作用工具的最小回执，避免恢复时重复执行。 */
export class ToolExecutionJournal {
	constructor(
		private readonly state: WorkspaceState,
		private readonly maxEntries = 100,
	) {}

	async begin(identity: ToolExecutionIdentity, tool: string): Promise<BeginResult> {
		const receipts = this.readAll();
		const key = this.key(identity);
		const existing = receipts[key];
		if (existing?.state === 'completed') {
			return { kind: 'completed', result: existing.result };
		}
		if (existing?.state === 'started') {
			return { kind: 'unknown' };
		}
		receipts[key] = { state: 'started', scopeId: identity.scopeId, callId: identity.callId, tool };
		await this.writeAll(receipts);
		return { kind: 'started' };
	}

	async complete(identity: ToolExecutionIdentity, result: ToolResult): Promise<void> {
		const receipts = this.readAll();
		const key = this.key(identity);
		const started = receipts[key];
		if (!started || started.state !== 'started') {
			return;
		}
		receipts[key] = { ...started, state: 'completed', result };
		await this.writeAll(receipts);
	}

	private readAll(): Record<string, Receipt> {
		return this.state.get<Record<string, Receipt>>(STATE_KEY) ?? {};
	}

	private async writeAll(receipts: Record<string, Receipt>): Promise<void> {
		const entries = Object.entries(receipts).slice(-this.maxEntries);
		await this.state.update(STATE_KEY, Object.fromEntries(entries));
	}

	private key(identity: ToolExecutionIdentity): string {
		return `${identity.scopeId}:${identity.callId}`;
	}
}
