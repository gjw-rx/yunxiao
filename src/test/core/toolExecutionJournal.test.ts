import * as assert from 'assert';
import { ToolExecutionJournal } from '../../core/toolExecutionJournal';
import type { WorkspaceState } from '../../core/runStore';

class MemoryState implements WorkspaceState {
	readonly values = new Map<string, unknown>();
	get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
	async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

describe('ToolExecutionJournal', () => {
	it('reuses terminal result without storing tool arguments', async () => {
		const state = new MemoryState();
		const journal = new ToolExecutionJournal(state);
		const identity = { scopeId: 'run-1', callId: 'call-1' };
		assert.deepStrictEqual(await journal.begin(identity, 'fs.write_file'), { kind: 'started' });
		await journal.complete(identity, { call_id: 'call-1', status: 'success', result: '已写入' });
		assert.deepStrictEqual(await journal.begin(identity, 'fs.write_file'), {
			kind: 'completed', result: { call_id: 'call-1', status: 'success', result: '已写入' },
		});
		assert.ok(!JSON.stringify([...state.values.values()]).includes('secret-content'));
	});

	it('treats an uncompleted receipt as unknown', async () => {
		const journal = new ToolExecutionJournal(new MemoryState());
		const identity = { scopeId: 'run-1', callId: 'call-1' };
		await journal.begin(identity, 'terminal.exec');
		assert.deepStrictEqual(await journal.begin(identity, 'terminal.exec'), { kind: 'unknown' });
	});
});
