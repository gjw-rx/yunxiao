/**
 * LocalSessionManager 测试。
 * 聚焦空会话（延迟创建，索引无条目）改名场景：
 * 必须先建立索引条目，否则 setCustomTitle 静默丢弃，且会话不出现在历史列表。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionFileStore } from '../../memory/sessionFileStore';
import { MessageStore } from '../../memory/messageStore';
import { LocalSessionManager } from '../../core/localSessionManager';
import type { AgentLoop } from '../../agent/agentLoop';

describe('LocalSessionManager', () => {
	let baseDir: string;
	let fileStore: SessionFileStore;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-lsm-test-'));
		fileStore = new SessionFileStore('/Users/test/My Project', baseDir);
	});

	afterEach(async () => {
		await fileStore.flush();
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	/** 构造 LocalSessionManager（AgentLoop 用无操作 mock；可注入共享 MessageStore）。 */
	function createManager(messageStore = new MessageStore(fileStore)): LocalSessionManager {
		const agentLoop = { run: async () => {}, cancel: () => {} } as unknown as AgentLoop;
		return new LocalSessionManager(agentLoop, messageStore);
	}

	it('空会话（未发消息）改名时先建立索引条目，改名生效且出现在历史列表', () => {
		const manager = createManager();
		const sessionId = manager.createSession();
		// 延迟创建：createSession 只设内存指针，索引无该会话
		assert.deepStrictEqual(manager.listSessions(), []);

		manager.renameSession(sessionId, '我的名字');

		const sessions = manager.listSessions();
		assert.strictEqual(sessions.length, 1, '改名后应建立索引条目');
		assert.strictEqual(sessions[0].sessionId, sessionId);
		assert.strictEqual(sessions[0].title, '我的名字');
		assert.strictEqual(sessions[0].customTitle, true);
	});

	it('已落盘的会话改名不重复建条目', () => {
		const messageStore = new MessageStore(fileStore);
		const manager = createManager(messageStore);
		const sessionId = manager.createSession();
		// 首条消息触发 MessageStore 延迟建条目（模拟真实 agentLoop 落盘）
		messageStore.append(sessionId, { role: 'user', content: 'hello' });

		manager.renameSession(sessionId, '重命名');

		const sessions = manager.listSessions();
		assert.strictEqual(sessions.length, 1, '不应重复建条目');
		assert.strictEqual(sessions[0].sessionId, sessionId);
		assert.strictEqual(sessions[0].title, '重命名');
		assert.strictEqual(sessions[0].messageCount, 1);
	});
});
