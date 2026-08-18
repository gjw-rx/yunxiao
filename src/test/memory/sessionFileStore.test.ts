/**
 * SessionFileStore 与 MessageStore 文件模式测试。
 * 使用临时目录作为存储根，避免污染真实 ~/.yunForce。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	SessionFileStore,
	encodeWorkspacePath,
	deriveTitle,
} from '../../memory/sessionFileStore';
import { MessageStore, migrateLegacyWorkspaceState } from '../../memory/messageStore';

/** 延时工具（制造时间戳差异，验证排序）。 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SessionFileStore', () => {
	let baseDir: string;
	let fileStore: SessionFileStore;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-test-'));
		fileStore = new SessionFileStore('/Users/test/My Project', baseDir);
	});

	afterEach(async () => {
		await fileStore.flush();
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	describe('encodeWorkspacePath', () => {
		it('将 / 与空格替换为 -', () => {
			assert.strictEqual(
				encodeWorkspacePath('/Users/jiaweigu/Python_project/VSCode插件开发/VSCode-plugin'),
				'-Users-jiaweigu-Python-project-VSCode-----VSCode-plugin',
			);
			assert.strictEqual(encodeWorkspacePath('/Users/test/My Project'), '-Users-test-My-Project');
		});
	});

	describe('deriveTitle', () => {
		it('折叠空白并截断至 40 字符', () => {
			assert.strictEqual(deriveTitle('  你好  世界  '), '你好 世界');
			const long = '啊'.repeat(50);
			assert.strictEqual(deriveTitle(long).length, 41); // 40 + 省略号
		});
	});

	describe('会话生命周期', () => {
		it('createSession 建立索引条目并设为当前会话', () => {
			fileStore.createSession('s1');
			const meta = fileStore.getSession('s1');
			assert.ok(meta);
			const m = meta!;
			assert.strictEqual(m.title, '');
			assert.strictEqual(m.messageCount, 0);
			assert.strictEqual(fileStore.listSessions().length, 1);
		});

		it('appendMessage 追加 v2 归档记录并更新索引', async () => {
			fileStore.createSession('s1');
			fileStore.appendMessage('s1', { role: 'user', content: '帮我修 bug', seq: 0 });
			fileStore.appendMessage('s1', { role: 'assistant', content: '好的', seq: 1 });
			await fileStore.flush();

			const file = path.join(fileStore.sessionDirPath, 's1.jsonl');
			const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
			// 首行为 v2 session header，后续为消息 Entry
			assert.strictEqual(lines.length, 3);
			assert.strictEqual(JSON.parse(lines[0]).type, 'session');
			assert.strictEqual(JSON.parse(lines[1]).payload.message.content, '帮我修 bug');
			assert.strictEqual(JSON.parse(lines[2]).payload.message.content, '好的');

			const meta = fileStore.getSession('s1');
			assert.ok(meta);
			assert.strictEqual(meta!.messageCount, 2);
			// 首条用户消息生成默认标题
			assert.strictEqual(meta!.title, '帮我修 bug');
		});

		it('readMessages 往返一致；坏行跳过', async () => {
			fileStore.createSession('s1');
			fileStore.appendMessage('s1', { role: 'user', content: 'a', seq: 0 });
			fileStore.appendMessage('s1', { role: 'assistant', content: 'b', seq: 1 });
			await fileStore.flush();
			// 手动写入坏行
			const file = path.join(fileStore.sessionDirPath, 's1.jsonl');
			fs.appendFileSync(file, 'not-json\n');

			const messages = fileStore.readMessages('s1');
			assert.strictEqual(messages.length, 2);
			assert.strictEqual(messages[0].role, 'user');
		});

		it('readMessages 文件不存在返回空数组', () => {
			assert.deepStrictEqual(fileStore.readMessages('nonexistent'), []);
		});

		it('rewriteSession 整体重写文件', async () => {
			fileStore.createSession('s1');
			fileStore.appendMessage('s1', { role: 'user', content: 'a', seq: 0 });
			fileStore.appendMessage('s1', { role: 'user', content: 'b', seq: 1 });
			fileStore.rewriteSession('s1', [{ role: 'user', content: 'a', seq: 0 }]);
			await fileStore.flush();

			assert.strictEqual(fileStore.readMessages('s1').length, 1);
			assert.strictEqual(fileStore.getSession('s1')!.messageCount, 1);
		});

		it('deleteSession 删除文件与索引条目', async () => {
			fileStore.createSession('s1');
			fileStore.appendMessage('s1', { role: 'user', content: 'a', seq: 0 });
			await fileStore.flush();
			assert.ok(fs.existsSync(path.join(fileStore.sessionDirPath, 's1.jsonl')));

			fileStore.deleteSession('s1');
			await fileStore.flush();
			assert.ok(!fs.existsSync(path.join(fileStore.sessionDirPath, 's1.jsonl')));
			assert.strictEqual(fileStore.getSession('s1'), undefined);
		});

		it('appendMessage 拒绝已删除会话（不重建幽灵文件）', async () => {
			fileStore.createSession('s1');
			fileStore.deleteSession('s1');
			fileStore.appendMessage('s1', { role: 'user', content: 'x', seq: 0 });
			await fileStore.flush();
			assert.ok(!fs.existsSync(path.join(fileStore.sessionDirPath, 's1.jsonl')));
			assert.strictEqual(fileStore.getSession('s1'), undefined);
		});

		it('setCustomTitle 后不再被首条消息覆盖', () => {
			fileStore.createSession('s1');
			fileStore.setCustomTitle('s1', '自定义名');
			fileStore.appendMessage('s1', { role: 'user', content: '默认标题候选', seq: 0 });
			assert.strictEqual(fileStore.getSession('s1')!.title, '自定义名');
			assert.strictEqual(fileStore.getSession('s1')!.customTitle, true);
		});

		it('listSessions 按 updatedAt 降序', async () => {
			fileStore.createSession('s1');
			await delay(5);
			fileStore.createSession('s2');
			await delay(5);
			fileStore.createSession('s3');
			await delay(5);
			// s2 最后活动（时间戳最新）
			fileStore.appendMessage('s2', { role: 'user', content: 'b', seq: 0 });
			const sessions = fileStore.listSessions();
			assert.strictEqual(sessions[0].sessionId, 's2');
			assert.strictEqual(sessions.length, 3);
		});

		it('索引缺失时自动重建为空', () => {
			fs.rmSync(path.join(fileStore.sessionDirPath, 'index.json'), { force: true });
			const reloaded = new SessionFileStore('/Users/test/My Project', baseDir);
			assert.deepStrictEqual(reloaded.listSessions(), []);
		});

		it('onDidChange 在索引变更时触发', () => {
			let changes = 0;
			const unsub = fileStore.onDidChange(() => changes++);
			fileStore.createSession('s1');
			fileStore.appendMessage('s1', { role: 'user', content: 'a', seq: 0 });
			fileStore.deleteSession('s1');
			unsub();
			fileStore.createSession('s2');
			assert.ok(changes >= 3);
			// 取消订阅后不再触发
			const before = changes;
			fileStore.createSession('s3');
			assert.strictEqual(changes, before);
		});
	});
});

describe('MessageStore 文件模式', () => {
	let baseDir: string;
	let fileStore: SessionFileStore;
	let store: MessageStore;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-msg-'));
		fileStore = new SessionFileStore('/Users/test/My Project', baseDir);
		store = new MessageStore(fileStore);
	});

	afterEach(async () => {
		await fileStore.flush();
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	it('延迟创建：空会话不落盘，首条消息自动建立记录', async () => {
		// 模拟「新建会话」后未发消息：不调用 createSession，索引与文件均无记录
		assert.deepStrictEqual(store.listSessions(), []);
		const jsonl = path.join(fileStore.sessionDirPath, 's-new.jsonl');
		assert.ok(!fs.existsSync(jsonl));

		// 首条消息自动建立索引条目并落盘（标题由首条用户消息生成）
		store.append('s-new', { role: 'user', content: 'hello' });
		await fileStore.flush();
		const meta = fileStore.getSession('s-new');
		assert.ok(meta);
		assert.strictEqual(meta!.messageCount, 1);
		assert.strictEqual(meta!.title, 'hello');
		assert.ok(fs.existsSync(jsonl));
		assert.strictEqual(store.listSessions().length, 1);
	});

	it('append 追加到文件，新实例可恢复', async () => {
		store.createSession('s1');
		store.append('s1', { role: 'user', content: 'hello' });
		store.append('s1', { role: 'assistant', content: 'hi' });
		await fileStore.flush();

		// 用同一 fileStore 构造新 MessageStore（模拟重启）
		const store2 = new MessageStore(fileStore);
		const history = store2.loadHistory('s1');
		assert.strictEqual(history.length, 2);
		assert.strictEqual((history[1] as { content: string }).content, 'hi');
	});

	it('clear 删除会话文件与索引', async () => {
		store.createSession('s1');
		store.append('s1', { role: 'user', content: 'a' });
		await fileStore.flush();
		assert.ok(fs.existsSync(path.join(fileStore.sessionDirPath, 's1.jsonl')));

		store.clear('s1');
		await fileStore.flush();
		assert.ok(!fs.existsSync(path.join(fileStore.sessionDirPath, 's1.jsonl')));
		assert.deepStrictEqual(store.listSessions(), []);
	});

	it('deleteMessagesAfter 重写文件', async () => {
		store.createSession('s1');
		for (let i = 0; i < 5; i++) {
			store.append('s1', { role: 'user', content: String(i) });
		}
		store.deleteMessagesAfter('s1', 2);
		await fileStore.flush();
		assert.strictEqual(store.loadHistory('s1').length, 3);
		assert.strictEqual(fileStore.readMessages('s1').length, 3);
	});

	it('updateMessage 重写文件', async () => {
		store.createSession('s1');
		const msg = store.append('s1', { role: 'assistant', content: 'x' });
		store.updateMessage('s1', msg.seq, { content: 'y' });
		await fileStore.flush();
		assert.strictEqual((fileStore.readMessages('s1')[0] as { content: string }).content, 'y');
	});

	it('超过旧上限（1000 条）时保留全部原始归档记录，不截断', async () => {
		store.createSession('s1');
		for (let i = 0; i < 1001; i++) {
			store.append('s1', { role: 'user', content: String(i) });
		}
		await fileStore.flush();
		// 归档层不再按条数上限删除原始记录：全部保留，仅由投影层限制展示/发送数量
		assert.strictEqual(store.loadHistory('s1').length, 1001);
		assert.strictEqual(fileStore.readMessages('s1').length, 1001);
		assert.strictEqual(fileStore.getSession('s1')!.messageCount, 1001);
	});

	it('listSessions/renameSession/setCurrentSessionId 转发到文件索引', () => {
		store.createSession('s1');
		store.renameSession('s1', '重命名');
		store.setCurrentSessionId('s1');
		const sessions = store.listSessions();
		assert.strictEqual(sessions.length, 1);
		assert.strictEqual(sessions[0].title, '重命名');
		assert.strictEqual(sessions[0].customTitle, true);
	});
});

describe('SessionFileStore 索引重建', () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-rebuild-test-'));
	});

	afterEach(() => {
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	/** 构造一个最小合法 v2 归档文件。 */
	function writeV2Archive(sessionId: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>): string {
		const dir = path.join(baseDir, encodeWorkspacePath('/Users/test/My Project'));
		fs.mkdirSync(dir, { recursive: true });
		const lines = [
			JSON.stringify({ type: 'session', version: 2, sessionId, createdAt: '2026-01-01T00:00:00.000Z', workspacePath: '/Users/test/My Project' }),
		];
		let parent: string | null = null;
		for (let i = 0; i < messages.length; i++) {
			const id = `id-${i + 1}`;
			lines.push(JSON.stringify({
				type: 'entry',
				kind: 'message',
				id,
				parentId: parent,
				recordSeq: i + 1,
				timestamp: `2026-01-01T00:00:0${i}.000Z`,
				payload: { kind: 'message', message: { ...messages[i], seq: i } },
			}));
			parent = id;
		}
		const file = path.join(dir, `${sessionId}.jsonl`);
		fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
		return dir;
	}

	it('索引缺失时从合法归档重建会话列表', () => {
		const store = new SessionFileStore('/Users/test/My Project', baseDir);
		store.createSession('s1');
		store.appendMessage('s1', { role: 'user', content: '你好', seq: 0 });
		store.appendMessage('s1', { role: 'assistant', content: '收到', seq: 1 });
		return store.flush().then(() => {
			const dir = path.join(baseDir, encodeWorkspacePath('/Users/test/My Project'));
			fs.rmSync(path.join(dir, 'index.json'), { force: true });
			// 重建索引：重新构造 store 触发扫描
			const rebuilt = new SessionFileStore('/Users/test/My Project', baseDir);
			const sessions = rebuilt.listSessions();
			assert.strictEqual(sessions.length, 1);
			assert.strictEqual(sessions[0].sessionId, 's1');
			assert.strictEqual(sessions[0].messageCount, 2);
			assert.strictEqual(sessions[0].title, '你好');
		});
	});

	it('索引损坏时从合法归档重建，不抛异常', () => {
		const dir = writeV2Archive('s1', [{ role: 'user', content: '内容' }]);
		fs.writeFileSync(path.join(dir, 'index.json'), 'not-valid-json{', 'utf8');
		const rebuilt = new SessionFileStore('/Users/test/My Project', baseDir);
		const sessions = rebuilt.listSessions();
		assert.strictEqual(sessions.length, 1);
		assert.strictEqual(sessions[0].sessionId, 's1');
		assert.strictEqual(sessions[0].messageCount, 1);
	});

	it('孤儿归档（有文件无索引条目）出现在重建后的列表', () => {
		const dir = writeV2Archive('orphan', [{ role: 'user', content: '孤儿会话' }]);
		const rebuilt = new SessionFileStore('/Users/test/My Project', baseDir);
		const sessions = rebuilt.listSessions();
		assert.strictEqual(sessions.length, 1);
		assert.strictEqual(sessions[0].sessionId, 'orphan');
		// 活动位置缓存已建立（线性历史头部=最后一条 entry）
		assert.strictEqual(rebuilt.getHeadEntryId('orphan'), 'id-1');
	});

	it('有消息记录但文件被删除的索引条目被清除', () => {
		const dir = writeV2Archive('s1', [{ role: 'user', content: '历史消息' }]);
		// 索引仍持有 s1 条目，但文件被删除 → 重建后清除孤儿
		fs.rmSync(path.join(dir, 's1.jsonl'));
		const rebuilt = new SessionFileStore('/Users/test/My Project', baseDir);
		assert.deepStrictEqual(rebuilt.listSessions(), []);
	});

	it('空会话（无文件）的索引条目保留（Todo/Plan sidecar 载体）', () => {
		const store = new SessionFileStore('/Users/test/My Project', baseDir);
		store.createSession('empty-s1');
		store.setPlanState('empty-s1', { stage: 'planning', draftCreated: true });
		return store.flush().then(() => {
			const rebuilt = new SessionFileStore('/Users/test/My Project', baseDir);
			const sessions = rebuilt.listSessions();
			assert.strictEqual(sessions.length, 1);
			assert.strictEqual(sessions[0].sessionId, 'empty-s1');
			assert.strictEqual(rebuilt.getPlanState('empty-s1').stage, 'planning');
		});
	});

	it('索引重建保留自定义标题', () => {
		const dir = writeV2Archive('s1', [{ role: 'user', content: '默认标题' }]);
		const store = new SessionFileStore('/Users/test/My Project', baseDir);
		store.setCustomTitle('s1', '自定义标题');
		return store.flush().then(() => {
			const rebuilt = new SessionFileStore('/Users/test/My Project', baseDir);
			const sessions = rebuilt.listSessions();
			assert.strictEqual(sessions.length, 1);
			assert.strictEqual(sessions[0].title, '自定义标题');
			assert.strictEqual(sessions[0].customTitle, true);
		});
	});
});

describe('SessionFileStore 旧格式迁移', () => {
	let baseDir: string;
	let store: SessionFileStore;
	let sessionDir: string;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-migrate-test-'));
		store = new SessionFileStore('/Users/test/My Project', baseDir);
		sessionDir = path.join(baseDir, encodeWorkspacePath('/Users/test/My Project'));
		fs.mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(async () => {
		await store.flush();
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	it('旧裸 JSONL 首次追加时惰性迁移为 v2，并保留 .bak 备份', async () => {
		// 旧格式：两行裸 Message，无 header
		fs.writeFileSync(
			path.join(sessionDir, 's1.jsonl'),
			`${JSON.stringify({ role: 'user', content: '旧消息1', seq: 0 })}\n${JSON.stringify({ role: 'assistant', content: '旧回复', seq: 1 })}\n`,
			'utf8',
		);
		store.createSession('s1');
		store.appendMessage('s1', { role: 'user', content: '新消息', seq: 2 });
		await store.flush();

		// 文件已迁移为 v2：首行为 header，消息顺序保持
		const raw = fs.readFileSync(path.join(sessionDir, 's1.jsonl'), 'utf8').trim().split('\n');
		assert.strictEqual(JSON.parse(raw[0]).type, 'session');
		assert.strictEqual(raw.length, 4);
		assert.strictEqual(JSON.parse(raw[1]).payload.message.content, '旧消息1');
		assert.strictEqual(JSON.parse(raw[2]).payload.message.content, '旧回复');
		assert.strictEqual(JSON.parse(raw[3]).payload.message.content, '新消息');
		// 原文件备份保留
		assert.ok(fs.existsSync(path.join(sessionDir, 's1.jsonl.bak')));
		// 读取投影一致（旧 2 + 新 1）
		assert.strictEqual(store.readMessages('s1').length, 3);
	});

	it('迁移后重启读取保持一致（线性历史与 seq）', async () => {
		fs.writeFileSync(
			path.join(sessionDir, 's2.jsonl'),
			`${JSON.stringify({ role: 'user', content: 'a', seq: 0 })}\n${JSON.stringify({ role: 'assistant', content: 'b', seq: 1 })}\n`,
			'utf8',
		);
		store.createSession('s2');
		store.appendMessage('s2', { role: 'user', content: 'c', seq: 2 });
		await store.flush();

		// 模拟重启：重新构造 store
		const rebuilt = new SessionFileStore('/Users/test/My Project', baseDir);
		const messages = rebuilt.readMessages('s2');
		assert.deepStrictEqual(
			messages.map((m) => ({ role: m.role, content: (m as { content: string }).content, seq: m.seq })),
			[
				{ role: 'user', content: 'a', seq: 0 },
				{ role: 'assistant', content: 'b', seq: 1 },
				{ role: 'user', content: 'c', seq: 2 },
			],
		);
		// 继续追加：recordSeq 连续
		rebuilt.appendMessage('s2', { role: 'assistant', content: 'd', seq: 3 });
		await rebuilt.flush();
		assert.strictEqual(rebuilt.readMessages('s2').length, 4);
	});

	it('迁移包含坏行时跳过坏行，迁移仍成功', async () => {
		fs.writeFileSync(
			path.join(sessionDir, 's3.jsonl'),
			`not-json\n${JSON.stringify({ role: 'user', content: '正常消息', seq: 0 })}\n`,
			'utf8',
		);
		store.createSession('s3');
		store.appendMessage('s3', { role: 'user', content: '追加', seq: 1 });
		await store.flush();
		const messages = store.readMessages('s3');
		assert.strictEqual(messages.length, 2);
		assert.strictEqual((messages[0] as { content: string }).content, '正常消息');
		assert.strictEqual((messages[1] as { content: string }).content, '追加');
	});

	it('旧 workspaceState 数据迁移为 v2 归档并清理旧键', async () => {
		let clearedKey: string | undefined;
		const state = {
			get(): Record<string, unknown> | undefined {
				return {
					'legacy-s1': [{ role: 'user', content: 'state旧消息', seq: 0 }],
					'legacy-s2': [{ role: 'user', content: 'state另一会话', seq: 0 }],
				};
			},
			update(key: string, value: unknown) {
				if (value === undefined) {
					clearedKey = key;
				}
				return Promise.resolve();
			},
		};
		const result = await migrateLegacyWorkspaceState(state as never, store);
		assert.strictEqual(result.migrated, 2);
		assert.strictEqual(result.failed, 0);
		assert.strictEqual(clearedKey, 'yunxiaoAgent.messages');
		// 迁移后文件为 v2 归档
		for (const sessionId of ['legacy-s1', 'legacy-s2']) {
			const raw = fs.readFileSync(path.join(sessionDir, `${sessionId}.jsonl`), 'utf8').trim().split('\n');
			assert.strictEqual(JSON.parse(raw[0]).type, 'session');
		}
	});

	it('迁移落盘失败时不清除旧 workspaceState 键', async () => {
		// 用同名文件阻塞会话目录，使任何落盘 mkdir 失败（跨平台稳定）
		fs.rmSync(sessionDir, { recursive: true, force: true });
		fs.writeFileSync(sessionDir, '', 'utf8');
		let cleared = false;
		const state = {
			get(): Record<string, unknown> | undefined {
				return { 'fail-s1': [{ role: 'user', content: 'x', seq: 0 }] };
			},
			update(key: string, value: unknown) {
				if (value === undefined) {
					cleared = true;
				}
				return Promise.resolve();
			},
		};
		const result = await migrateLegacyWorkspaceState(state as never, store);
		// 迁移不抛异常、不阻塞，且旧键保留（可安全重试）
		assert.strictEqual(result.migrated, 0);
		assert.strictEqual(result.failed, 1);
		assert.strictEqual(cleared, false);
	});
});
