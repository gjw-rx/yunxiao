/**
 * LocalSessionManager Plan 模式生命周期测试。
 * 覆盖：进入、继续规划、放弃（草案清理）、确认执行（隐藏执行指令）、
 * 运行中拒绝、活跃任务拒绝、重复操作与过期会话操作。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventBus } from '../../core/eventBus';
import { LocalSessionManager } from '../../core/localSessionManager';
import { SessionPlanModeStore } from '../../core/planModeStore';
import type { AgentLoop } from '../../agent/agentLoop';
import { MessageStore } from '../../memory/messageStore';
import { SessionFileStore } from '../../memory/sessionFileStore';
import { SessionTodoStore } from '../../memory/sessionTodoStore';

/** 可编程 AgentLoop mock：记录 run 调用与运行状态。 */
class FakeAgentLoop {
	/** 已启动的 run 调用。 */
	readonly runs: Array<{ sessionId: string; text: string; hidden?: boolean }> = [];
	/** 标记为运行中的会话。 */
	readonly running = new Set<string>();

	/** 记录 run 调用。 */
	async run(sessionId: string, text: string, options?: { readonly hidden?: boolean }): Promise<void> {
		this.runs.push({ sessionId, text, hidden: options?.hidden });
	}

	/** 取消（无操作）。 */
	cancel(): void {
		// noop
	}

	/** 会话是否运行中。 */
	isRunning(sessionId: string): boolean {
		return this.running.has(sessionId);
	}
}

describe('LocalSessionManager Plan 模式', () => {
	let baseDir: string;
	let fileStore: SessionFileStore;
	let eventBus: EventBus;
	let planMode: SessionPlanModeStore;
	let todoStore: SessionTodoStore;
	let agentLoop: FakeAgentLoop;
	let manager: LocalSessionManager;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-lsm-plan-'));
		fileStore = new SessionFileStore('/Users/test/Plan LSM', baseDir);
		eventBus = new EventBus();
		planMode = new SessionPlanModeStore(fileStore, eventBus);
		todoStore = new SessionTodoStore(fileStore);
		agentLoop = new FakeAgentLoop();
		manager = new LocalSessionManager(
			agentLoop as unknown as AgentLoop,
			new MessageStore(fileStore),
			undefined,
			undefined,
			undefined,
			planMode,
			todoStore,
			eventBus,
		);
	});

	afterEach(async () => {
		await fileStore.flush();
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	it('从 normal 进入 planning，不发送任何消息', () => {
		fileStore.createSession('s1');
		manager.enterPlanMode('s1');
		assert.strictEqual(planMode.getState('s1').stage, 'planning');
		assert.strictEqual(agentLoop.runs.length, 0);
	});

	it('运行中拒绝进入/继续/退出/确认', () => {
		fileStore.createSession('s1');
		agentLoop.running.add('s1');
		planMode.transition('s1', 'planning');
		assert.throws(() => manager.enterPlanMode('s1'), /正在生成/);
		planMode.transition('s1', 'review');
		assert.throws(() => manager.continuePlanning('s1'), /正在生成/);
		assert.throws(() => manager.exitPlanMode('s1'), /正在生成/);
		assert.throws(() => manager.confirmExecution('s1'), /正在生成/);
	});

	it('存在活跃 Todo 时拒绝进入 Plan 模式', () => {
		fileStore.createSession('s1');
		todoStore.write('s1', [{ id: 't1', content: '任务', status: 'pending' }]);
		assert.throws(() => manager.enterPlanMode('s1'), /未完成任务/);
		assert.strictEqual(planMode.getState('s1').stage, 'normal');
	});

	it('review 继续规划恢复 planning 并保留草案', () => {
		fileStore.createSession('s1');
		planMode.transition('s1', 'planning');
		planMode.transition('s1', 'review');
		todoStore.write('s1', [{ id: 'p1', content: '计划', status: 'pending' }]);

		manager.continuePlanning('s1');
		assert.strictEqual(planMode.getState('s1').stage, 'planning');
		assert.deepStrictEqual(todoStore.read('s1').todos, [{ id: 'p1', content: '计划', status: 'pending' }]);
	});

	it('退出 review 并清空本轮草案，同步 todo_state_change 事件', () => {
		fileStore.createSession('s1');
		planMode.transition('s1', 'planning');
		planMode.transition('s1', 'review');
		todoStore.write('s1', [{ id: 'p1', content: '计划', status: 'pending' }]);
		let payload: unknown;
		eventBus.on('todo_state_change', (e) => { payload = e.payload; });

		manager.exitPlanMode('s1');
		assert.strictEqual(planMode.getState('s1').stage, 'normal');
		assert.deepStrictEqual(todoStore.read('s1').todos, []);
		assert.ok(payload);
	});

	it('未创建本轮草案时退出不误删旧 Todo 快照', () => {
		fileStore.createSession('s1');
		todoStore.write('s1', [{ id: 'old', content: '旧任务', status: 'in_progress' }]);
		// 旧快照存在时进入规划（draftCreated=false），退出不清空
		planMode.transition('s1', 'planning');
		assert.strictEqual(planMode.getState('s1').draftCreated, false);

		manager.exitPlanMode('s1');
		assert.strictEqual(planMode.getState('s1').stage, 'normal');
		assert.deepStrictEqual(todoStore.read('s1').todos, [{ id: 'old', content: '旧任务', status: 'in_progress' }]);
	});

	it('确认执行：先 executing 再启动同会话隐藏执行指令，不创建新会话', () => {
		fileStore.createSession('s1');
		planMode.transition('s1', 'planning');
		planMode.transition('s1', 'review');
		todoStore.write('s1', [{ id: 'p1', content: '计划', status: 'pending' }]);

		manager.confirmExecution('s1');
		assert.strictEqual(planMode.getState('s1').stage, 'executing');
		assert.strictEqual(agentLoop.runs.length, 1);
		assert.strictEqual(agentLoop.runs[0].sessionId, 's1');
		assert.strictEqual(agentLoop.runs[0].hidden, true);
		assert.ok(agentLoop.runs[0].text.includes('Continue executing'));
	});

	it('review 阶段计划无待执行任务时拒绝确认执行', () => {
		fileStore.createSession('s1');
		planMode.transition('s1', 'planning');
		planMode.transition('s1', 'review');
		todoStore.write('s1', [{ id: 'done', content: '已完成', status: 'completed' }]);

		assert.throws(() => manager.confirmExecution('s1'), /没有待执行任务/);
		assert.strictEqual(planMode.getState('s1').stage, 'review');
		assert.strictEqual(agentLoop.runs.length, 0);
	});

	it('重复操作：planning 再次进入被拒绝', () => {
		fileStore.createSession('s1');
		manager.enterPlanMode('s1');
		assert.throws(() => manager.enterPlanMode('s1'), /不能开始新的规划/);
	});

	it('过期会话操作不改变其他会话状态', () => {
		fileStore.createSession('s1');
		fileStore.createSession('s2');
		manager.enterPlanMode('s1');
		// 对 s2（normal）执行 s1 专属操作被拒绝
		assert.throws(() => manager.continuePlanning('s2'), /不能继续规划/);
		assert.throws(() => manager.confirmExecution('s2'), /不能执行计划/);
		assert.throws(() => manager.exitPlanMode('s2'), /不在 Plan 模式/);
		// s1 状态保持
		assert.strictEqual(planMode.getState('s1').stage, 'planning');
		assert.strictEqual(planMode.getState('s2').stage, 'normal');
	});
});
