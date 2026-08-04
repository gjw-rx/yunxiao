import * as assert from 'assert';
import { RunStore, type StoredRun, type WorkspaceState } from '../../core/runStore';

class MemoryState implements WorkspaceState {
	private readonly values = new Map<string, unknown>();
	get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
	async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

function run(): StoredRun {
	return { sessionId: 's1', runId: 'r1', cursor: 0, status: 'running', workspaceRoots: ['D:/work'], events: [], timeline: [] };
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

	it('projects accepted budget and content-batch events into the bounded timeline', async () => {
		const store = new RunStore(new MemoryState(), 2);
		await store.save(run());
		await store.append('s1', { sequence: 1, type: 'content_batch', payload: { content: 'first' } });
		await store.append('s1', { sequence: 2, type: 'budget_update', payload: { usage: { tokens: 3 }, limits: { tokens: 10 } } });
		await store.append('s1', { sequence: 3, type: 'budget_exhausted', payload: { dimension: 'tokens' } });
		const saved = store.get('s1');
		assert.deepStrictEqual(saved?.timeline.map((event) => event.sequence), [2, 3]);
		assert.deepStrictEqual(saved?.budget, { usage: { tokens: 3 }, limits: { tokens: 10 } });
	});

	it('normalizes legacy snapshots without timeline data', async () => {
		const state = new MemoryState();
		await state.update('yunxiaoAgent.runStore.v1', {
			s1: { sessionId: 's1', runId: 'r1', cursor: 0, status: 'running', workspaceRoots: [], events: [] },
		});
		const store = new RunStore(state);
		assert.deepStrictEqual(store.get('s1')?.timeline, []);
		assert.strictEqual(store.get('s1')?.budget, undefined);
	});
});
