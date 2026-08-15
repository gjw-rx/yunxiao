/**
 * 会话任务快照存储与 todo_write 工具测试。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventBus } from '../../core/eventBus';
import { ToolValidationError } from '../../core/errors';
import { SessionFileStore } from '../../memory/sessionFileStore';
import { SessionTodoStore } from '../../memory/sessionTodoStore';
import { TodoWriteTool } from '../../tools/todo/todoWrite';

/**
 * 创建两条有效任务的完整快照参数。
 * @returns 工具调用参数。
 */
function validTodos(): Record<string, unknown> {
	return {
		todos: [
			{ id: 'plan', content: '梳理实施方案', status: 'completed' },
			{ id: 'implement', content: '实现任务工具', status: 'in_progress' },
		],
	};
}

describe('SessionTodoStore', () => {
	let baseDir: string;
	let fileStore: SessionFileStore;
	let todoStore: SessionTodoStore;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-todo-'));
		fileStore = new SessionFileStore('/Users/test/Todo Project', baseDir);
		todoStore = new SessionTodoStore(fileStore);
	});

	afterEach(async () => {
		await fileStore.flush();
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	it('以全量快照替换任务，并在重启后保持会话隔离', async () => {
		fileStore.createSession('s1');
		fileStore.createSession('s2');
		todoStore.write('s1', validTodos().todos);
		todoStore.write('s2', [{ id: 'other', content: '另一个会话任务', status: 'pending' }]);
		await fileStore.flush();

		const reloaded = new SessionTodoStore(new SessionFileStore('/Users/test/Todo Project', baseDir));
		assert.strictEqual(reloaded.read('s1').todos.length, 2);
		assert.strictEqual(reloaded.read('s1').todos[1].status, 'in_progress');
		assert.strictEqual(reloaded.read('s2').todos[0].id, 'other');

		todoStore.write('s1', []);
		assert.deepStrictEqual(todoStore.read('s1').todos, []);
	});

	it('拒绝重复标识、非法状态及多个进行中任务', () => {
		assert.throws(
			() => todoStore.write('s1', [{ id: 'same', content: '任务一', status: 'pending' }, { id: 'same', content: '任务二', status: 'pending' }]),
			ToolValidationError
		);
		assert.throws(
			() => todoStore.write('s1', [{ id: 'bad', content: '非法状态', status: 'paused' }]),
			ToolValidationError
		);
		assert.throws(
			() => todoStore.write('s1', [{ id: 'one', content: '任务一', status: 'in_progress' }, { id: 'two', content: '任务二', status: 'in_progress' }]),
			ToolValidationError
		);
	});

	it('删除会话时同步清理任务快照', () => {
		fileStore.createSession('s1');
		todoStore.write('s1', validTodos().todos);
		fileStore.deleteSession('s1');
		assert.deepStrictEqual(todoStore.read('s1').todos, []);
	});

	it('todo_write 写入快照并广播任务状态变更', async () => {
		const eventBus = new EventBus();
		const tool = new TodoWriteTool(todoStore, eventBus);
		let payload: unknown;
		eventBus.on('todo_state_change', (event) => {
			payload = event.payload;
		});

		const result = await tool.execute(validTodos(), { workspaceRoots: [], sessionId: 's1' });
		assert.strictEqual(tool.permission, 'read');
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('implement'));
		assert.deepStrictEqual(payload, {
			snapshot: { todos: validTodos().todos },
			summary: { total: 2, pending: 0, in_progress: 1, completed: 1, cancelled: 0 },
		});
	});
});
