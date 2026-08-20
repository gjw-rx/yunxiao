/**
 * 归档生命周期集成测试：回滚与永久删除的持久化语义、损坏归档拒绝、
 * AgentLoop 提交边界（提交失败发布 failed）。覆盖 change 的 conversation-delete-rollback
 * 与 session-history-storage 相关新增/修改场景。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MessageStore } from '../../memory/messageStore';
import { SessionFileStore } from '../../memory/sessionFileStore';
import { loadHistoryForLLM } from '../../memory/historyLoader';
import { AgentLoop } from '../../agent/agentLoop';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { EventBus } from '../../core/eventBus';
import type { LLMProvider } from '../../llm/types';

/** 创建只返回文本的 Provider。 */
function textProvider(text = '完成'): LLMProvider {
	return {
		async *chatCompletion() {
			yield { type: 'textDelta' as const, text };
			yield { type: 'finish' as const, reason: 'stop' as const };
		},
	};
}

describe('归档生命周期', () => {
	let baseDir: string;
	let fileStore: SessionFileStore;
	let store: MessageStore;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-lifecycle-'));
		fileStore = new SessionFileStore('/users/test/ws', baseDir);
		store = new MessageStore(fileStore);
	});

	afterEach(async () => {
		await fileStore.flush();
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	it('回滚保留原始归档 Entry 并持久化活动位置（跨重启恢复）', async () => {
		store.createSession('s1');
		store.append('s1', { role: 'user', content: '消息0' }); // seq 0
		store.append('s1', { role: 'assistant', content: '回复1' }); // seq 1
		store.append('s1', { role: 'user', content: '消息2' }); // seq 2
		store.append('s1', { role: 'assistant', content: '回复3' }); // seq 3
		await fileStore.flush();

		// 回滚到 seq=1 之前（保留 seq 0..1）
		store.rollbackMessagesAfter('s1', 1);
		await fileStore.flush();

		assert.deepStrictEqual(
			store.loadHistory('s1').map((m) => m.seq),
			[0, 1],
		);
		// 原始 Entry 全部保留（4 条消息 + header + head_update = 6 行）
		const raw = fs.readFileSync(path.join(fileStore.sessionDirPath, 's1.jsonl'), 'utf8').trim().split('\n');
		assert.strictEqual(raw.length, 6);
		// 最后一行是 head_update
		const last = JSON.parse(raw[raw.length - 1]);
		assert.strictEqual(last.type, 'entry');
		assert.strictEqual(last.kind, 'head_update');

		// 模拟重启：重新构造 store，活动路径应为 seq 0..1
		const rebuilt = new MessageStore(new SessionFileStore('/users/test/ws', baseDir));
		assert.deepStrictEqual(
			rebuilt.loadHistory('s1').map((m) => m.seq),
			[0, 1],
		);

		// 回滚后继续追加：新消息成为活动路径的后继
		rebuilt.append('s1', { role: 'user', content: '重发消息' }); // seq 2
		await rebuilt.commit('s1');
		assert.deepStrictEqual(
			rebuilt.loadHistory('s1').map((m) => (m as { content: string }).content),
			['消息0', '回复1', '重发消息'],
		);
	});

	it('永久删除物理清理目标消息与文件，回滚不物理删除', async () => {
		store.createSession('s1');
		store.append('s1', { role: 'user', content: 'a' }); // seq 0
		store.append('s1', { role: 'assistant', content: 'b' }); // seq 1
		store.append('s1', { role: 'user', content: 'c' }); // seq 2
		store.append('s1', { role: 'assistant', content: 'd' }); // seq 3
		await fileStore.flush();

		// 回滚（活动投影截断，文件行 6 行：header+4 消息+head_update）
		store.rollbackMessagesAfter('s1', 1);
		await fileStore.flush();
		const afterRollback = fs.readFileSync(path.join(fileStore.sessionDirPath, 's1.jsonl'), 'utf8').trim().split('\n');
		assert.strictEqual(afterRollback.length, 6);

		// 永久删除：deleteMessagesAfter 物理重写（保留 seq 0，文件 header+1 消息=2 行）
		store.deleteMessagesAfter('s1', 0);
		await fileStore.flush();
		const afterDelete = fs.readFileSync(path.join(fileStore.sessionDirPath, 's1.jsonl'), 'utf8').trim().split('\n');
		assert.strictEqual(afterDelete.length, 2);
		assert.deepStrictEqual(
			store.loadHistory('s1').map((m) => (m as { content: string }).content),
			['a'],
		);

		// 删除会话：文件被物理移除
		store.clear('s1');
		await fileStore.flush();
		assert.ok(!fs.existsSync(path.join(fileStore.sessionDirPath, 's1.jsonl')));
		assert.deepStrictEqual(store.loadHistory('s1'), []);
	});

	it('损坏归档被 HistoryLoader 拒绝，不进入 LLM 上下文', async () => {
		store.createSession('s1');
		store.append('s1', { role: 'user', content: 'a' });
		await fileStore.flush();
		// 手工篡改：把 compaction 边界指向不存在的 Entry（伪造损坏归档）
		const file = path.join(fileStore.sessionDirPath, 's1.jsonl');
		const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
		const header = JSON.parse(lines[0]);
		const entry1 = JSON.parse(lines[1]);
		const corrupt = JSON.stringify({
			...header,
		});
		const badCompaction = JSON.stringify({
			type: 'entry',
			kind: 'compaction',
			id: 'c-broken',
			parentId: entry1.id,
			recordSeq: 2,
			timestamp: new Date().toISOString(),
			payload: { kind: 'compaction', summary: '摘要', firstKeptEntryId: 'missing-entry' },
		});
		fs.writeFileSync(file, `${corrupt}\n${JSON.stringify(entry1)}\n${badCompaction}\n`, 'utf8');
		// 重建 store 使内存缓存失效
		const rebuilt = new MessageStore(new SessionFileStore('/users/test/ws', baseDir));
		assert.throws(() => {
			loadHistoryForLLM('s1', rebuilt);
		}, /归档损坏/);
		assert.ok(rebuilt.getArchiveDiagnostics('s1').length > 0);
	});
});

describe('AgentLoop 提交边界', () => {
	it('提交失败时发布 failed 而非 completed', async () => {
		const eventBus = new EventBus();
		const states: string[] = [];
		eventBus.on('run_state_change', (e) => {
			states.push((e.payload as { state: string }).state);
		});
		// 消息存储：commit 强制失败
		class FailingStore extends MessageStore {
			override async commit(): Promise<void> {
				throw new Error('磁盘写入失败（模拟）');
			}
		}
		const store = new FailingStore();
		const registry = new ToolRegistry();
		const loop = new AgentLoop(textProvider(), store, new ToolRouter(registry), registry, eventBus, {
			model: 'test-model',
			temperature: 0,
			maxTokens: 4096,
			maxSteps: 25,
			workspaceRoots: ['/test'],
		});
		await loop.run('s1', '你好');
		// 循环开头的提交确认失败 → 发布 failed（而非 completed）
		assert.ok(states.includes('failed'), `期望出现 failed，实际状态序列=${states.join(',')}`);
		assert.ok(!states.includes('completed'), `不得发布 completed，实际状态序列=${states.join(',')}`);
	});

	it('正常完成前确认归档提交成功后才发布 completed', async () => {
		const eventBus = new EventBus();
		const order: string[] = [];
		eventBus.on('run_state_change', (e) => {
			const state = (e.payload as { state: string }).state;
			order.push(`state:${state}`);
		});
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-commit-ok-'));
		const fileStore = new SessionFileStore('/users/test/ws', baseDir);
		const store = new MessageStore(fileStore);
		const registry = new ToolRegistry();
		const loop = new AgentLoop(textProvider(), store, new ToolRouter(registry), registry, eventBus, {
			model: 'test-model',
			temperature: 0,
			maxTokens: 4096,
			maxSteps: 25,
			workspaceRoots: ['/test'],
		});
		await loop.run('s1', '你好');
		await fileStore.flush();
		// 正常流程发布 completed，且归档已落盘（用户消息 + assistant 回复）
		assert.ok(order.includes('state:completed'), `期望 completed，实际=${order.join(',')}`);
		const raw = fs.readFileSync(path.join(fileStore.sessionDirPath, 's1.jsonl'), 'utf8').trim().split('\n');
		assert.strictEqual(JSON.parse(raw[0]).type, 'session');
		assert.strictEqual(raw.length, 3); // header + 用户消息 + assistant 回复
		fs.rmSync(baseDir, { recursive: true, force: true });
	});
});