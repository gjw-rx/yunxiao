/**
 * Plan 模式状态存储与服务测试。
 * 覆盖：Plan 状态规范化、旧索引兼容、非法值回退、会话隔离，
 * 以及 SessionPlanModeStore 的合法转换、事件广播与日志。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventBus } from '../../core/eventBus';
import { SessionFileStore } from '../../memory/sessionFileStore';
import { SessionPlanModeStore } from '../../core/planModeStore';

/** 构造一个不含 planStates 字段的旧版 index.json 并落盘。 */
function writeLegacyIndex(fileStore: SessionFileStore, workspacePath: string): void {
	fs.mkdirSync(fileStore.sessionDirPath, { recursive: true });
	fs.writeFileSync(
		path.join(fileStore.sessionDirPath, 'index.json'),
		JSON.stringify({
			version: 1,
			workspacePath,
			sessions: {
				s1: {
					sessionId: 's1',
					title: '旧会话',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
					messageCount: 1,
					customTitle: false,
				},
			},
			todos: {},
		}),
		'utf8'
	);
}

describe('SessionFileStore Plan 状态', () => {
	let baseDir: string;
	let fileStore: SessionFileStore;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-plan-store-'));
		fileStore = new SessionFileStore('/Users/test/Plan Project', baseDir);
	});

	afterEach(async () => {
		await fileStore.flush();
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	it('无 Plan 状态时按 normal 读取', () => {
		assert.deepStrictEqual(fileStore.getPlanState('s1'), { stage: 'normal', draftCreated: false });
	});

	it('setPlanState 原子持久化并可重启恢复', async () => {
		fileStore.createSession('s1');
		fileStore.setPlanState('s1', { stage: 'review', draftCreated: true });
		await fileStore.flush();

		const reloaded = new SessionFileStore('/Users/test/Plan Project', baseDir);
		assert.deepStrictEqual(reloaded.getPlanState('s1'), { stage: 'review', draftCreated: true });
	});

	it('旧索引缺少 planStates 时按 normal 加载，不阻塞历史', () => {
		writeLegacyIndex(fileStore, '/Users/test/Plan Project');
		const reloaded = new SessionFileStore('/Users/test/Plan Project', baseDir);
		assert.deepStrictEqual(reloaded.getPlanState('s1'), { stage: 'normal', draftCreated: false });
		assert.strictEqual(reloaded.getSession('s1')!.title, '旧会话');
	});

	it('非法 stage 与损坏结构回退 normal', () => {
		fs.mkdirSync(fileStore.sessionDirPath, { recursive: true });
		fs.writeFileSync(
			path.join(fileStore.sessionDirPath, 'index.json'),
			JSON.stringify({
				version: 1,
				workspacePath: '/Users/test/Plan Project',
				sessions: {},
				todos: {},
				planStates: {
					s1: { stage: 'paused', draftCreated: true },
					s2: 'not-an-object',
					s3: { stage: 'planning', draftCreated: 'yes' },
					s4: { stage: 'executing', draftCreated: true },
				},
			}),
			'utf8'
		);
		const reloaded = new SessionFileStore('/Users/test/Plan Project', baseDir);
		assert.deepStrictEqual(reloaded.getPlanState('s1'), { stage: 'normal', draftCreated: false });
		assert.deepStrictEqual(reloaded.getPlanState('s2'), { stage: 'normal', draftCreated: false });
		assert.deepStrictEqual(reloaded.getPlanState('s3'), { stage: 'planning', draftCreated: false });
		assert.deepStrictEqual(reloaded.getPlanState('s4'), { stage: 'executing', draftCreated: true });
	});

	it('会话隔离：不同会话 Plan 状态互不影响', () => {
		fileStore.createSession('s1');
		fileStore.createSession('s2');
		fileStore.setPlanState('s1', { stage: 'planning', draftCreated: false });
		assert.deepStrictEqual(fileStore.getPlanState('s1'), { stage: 'planning', draftCreated: false });
		assert.deepStrictEqual(fileStore.getPlanState('s2'), { stage: 'normal', draftCreated: false });
	});

	it('deleteSession 同步清理 Plan 状态', async () => {
		fileStore.createSession('s1');
		fileStore.setPlanState('s1', { stage: 'review', draftCreated: true });
		fileStore.deleteSession('s1');
		await fileStore.flush();

		const reloaded = new SessionFileStore('/Users/test/Plan Project', baseDir);
		assert.deepStrictEqual(reloaded.getPlanState('s1'), { stage: 'normal', draftCreated: false });
	});
});

describe('SessionPlanModeStore', () => {
	let baseDir: string;
	let fileStore: SessionFileStore;
	let eventBus: EventBus;
	let store: SessionPlanModeStore;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-plan-mode-'));
		fileStore = new SessionFileStore('/Users/test/Plan Mode', baseDir);
		eventBus = new EventBus();
		store = new SessionPlanModeStore(fileStore, eventBus);
	});

	afterEach(async () => {
		await fileStore.flush();
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	it('进入规划重置草案标记并广播 plan_mode_change', () => {
		fileStore.createSession('s1');
		const events: unknown[] = [];
		eventBus.on('plan_mode_change', (e) => events.push(e.payload));

		const state = store.transition('s1', 'planning');
		assert.deepStrictEqual(state, { stage: 'planning', draftCreated: false });
		assert.deepStrictEqual(store.getState('s1'), { stage: 'planning', draftCreated: false });
		assert.deepStrictEqual(events, [{ from: 'normal', to: 'planning', draftCreated: false }]);
	});

	it('规划提交后进入 review 并标记草案已创建', () => {
		fileStore.createSession('s1');
		store.transition('s1', 'planning');
		const state = store.transition('s1', 'review');
		assert.deepStrictEqual(state, { stage: 'review', draftCreated: true });
	});

	it('继续规划保留草案标记，确认执行保持草案', () => {
		fileStore.createSession('s1');
		store.transition('s1', 'planning');
		store.transition('s1', 'review');
		assert.deepStrictEqual(store.transition('s1', 'planning'), { stage: 'planning', draftCreated: true });
		assert.deepStrictEqual(store.transition('s1', 'review'), { stage: 'review', draftCreated: true });
		assert.deepStrictEqual(store.transition('s1', 'executing'), { stage: 'executing', draftCreated: true });
	});

	it('退出规划/审阅/执行均回到 normal 并重置草案标记', () => {
		fileStore.createSession('s1');
		store.transition('s1', 'planning');
		store.transition('s1', 'review');
		assert.deepStrictEqual(store.transition('s1', 'normal'), { stage: 'normal', draftCreated: false });

		store.transition('s1', 'planning');
		assert.deepStrictEqual(store.transition('s1', 'normal'), { stage: 'normal', draftCreated: false });

		store.transition('s1', 'planning');
		store.transition('s1', 'review');
		store.transition('s1', 'executing');
		assert.deepStrictEqual(store.transition('s1', 'normal'), { stage: 'normal', draftCreated: false });
	});

	it('非法转换被拒绝且不改变状态、不发事件', () => {
		fileStore.createSession('s1');
		const events: unknown[] = [];
		eventBus.on('plan_mode_change', (e) => events.push(e.payload));

		assert.throws(() => store.transition('s1', 'executing'), /非法/);
		assert.throws(() => store.transition('s1', 'normal'), /非法/);
		assert.deepStrictEqual(store.getState('s1'), { stage: 'normal', draftCreated: false });
		assert.strictEqual(events.length, 0);
	});

	it('重启后按持久化状态恢复', async () => {
		fileStore.createSession('s1');
		store.transition('s1', 'planning');
		store.transition('s1', 'review');
		await fileStore.flush();

		const reloaded = new SessionPlanModeStore(
			new SessionFileStore('/Users/test/Plan Mode', baseDir),
			new EventBus()
		);
		assert.deepStrictEqual(reloaded.getState('s1'), { stage: 'review', draftCreated: true });
	});

	it('会话隔离：切换其他会话不受影响', () => {
		fileStore.createSession('s1');
		fileStore.createSession('s2');
		store.transition('s1', 'planning');
		assert.deepStrictEqual(store.getState('s2'), { stage: 'normal', draftCreated: false });
	});
});
