import * as assert from 'assert';
import { RunStore, type StoredRun, type WorkspaceState } from '../../core/runStore';

class MemoryState implements WorkspaceState {
	private readonly values = new Map<string, unknown>();
	get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
	async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

function run(): StoredRun {
	return { sessionId: 's1', runId: 'r1', cursor: 0, status: 'running', workspaceRoots: ['D:/work'], events: [] };
}

describe('RunStore', () => {
	it('persists a run snapshot and removes it on reset', async () => {
		const store = new RunStore(new MemoryState());
		await store.save(run());
		assert.strictEqual(store.get('s1')?.runId, 'r1');
		await store.remove('s1');
		assert.strictEqual(store.get('s1'), undefined);
	});

	it('deduplicates events and reports a gap without advancing the cursor', async () => {
		const store = new RunStore(new MemoryState());
		await store.save(run());
		assert.strictEqual((await store.append('s1', { sequence: 1, type: 'content', payload: 'a' })).kind, 'appended');
		assert.strictEqual((await store.append('s1', { sequence: 1, type: 'content', payload: 'a' })).kind, 'duplicate');
		const gap = await store.append('s1', { sequence: 3, type: 'content', payload: 'c' });
		assert.strictEqual(gap.kind, 'gap');
		assert.strictEqual(gap.kind === 'gap' && gap.expectedSequence, 2);
		assert.strictEqual(store.get('s1')?.cursor, 1);
	});

	it('retains only the configured recent event window', async () => {
		const store = new RunStore(new MemoryState(), 2);
		await store.save(run());
		await store.append('s1', { sequence: 1, type: 'content', payload: 'a' });
		await store.append('s1', { sequence: 2, type: 'content', payload: 'b' });
		await store.append('s1', { sequence: 3, type: 'content', payload: 'c' });
		assert.deepStrictEqual(store.get('s1')?.events.map((event) => event.sequence), [2, 3]);
	});

	it('restores only non-terminal runs', async () => {
		const store = new RunStore(new MemoryState());
		await store.save(run());
		await store.save({ ...run(), sessionId: 's2', runId: 'r2', status: 'completed' });
		assert.deepStrictEqual(store.listRestorable().map((item) => item.sessionId), ['s1']);
	});
});
