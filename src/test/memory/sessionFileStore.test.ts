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
import { MessageStore } from '../../memory/messageStore';

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

		it('appendMessage 追加 JSONL 行并更新索引', async () => {
			fileStore.createSession('s1');
			fileStore.appendMessage('s1', { role: 'user', content: '帮我修 bug', seq: 0 });
			fileStore.appendMessage('s1', { role: 'assistant', content: '好的', seq: 1 });
			await fileStore.flush();

			const file = path.join(fileStore.sessionDirPath, 's1.jsonl');
			const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
			assert.strictEqual(lines.length, 2);
			assert.strictEqual(JSON.parse(lines[0]).content, '帮我修 bug');

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

	it('超过 1000 条时重写文件保持上限（索引与文件一致）', async () => {
		store.createSession('s1');
		for (let i = 0; i < 1001; i++) {
			store.append('s1', { role: 'user', content: String(i) });
		}
		await fileStore.flush();
		assert.strictEqual(store.loadHistory('s1').length, 1000);
		assert.strictEqual(fileStore.readMessages('s1').length, 1000);
		assert.strictEqual(fileStore.getSession('s1')!.messageCount, 1000);
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
