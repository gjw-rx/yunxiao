import * as assert from 'assert';
import {
	ApprovalGateway,
	type ApprovalDecision,
	type ApprovalPrompter,
	type ApprovalConfigStore,
} from '../../core/approvalGateway';

/** 构造可编程的 mock 提示器：按队列返回决策。 */
function mockPrompter(responses: (ApprovalDecision | undefined)[]): {
	prompter: ApprovalPrompter;
	calls: string[];
} {
	const calls: string[] = [];
	let i = 0;
	return {
		prompter: {
			async prompt(ctx: { summary: string }): Promise<ApprovalDecision | undefined> {
				calls.push(ctx.summary);
				return responses[i++];
			},
		},
		calls,
	};
}

/** 可检查的 mock 配置存储。added/alwaysAllow 暴露在 store 上便于断言。 */
function mockStore(initial: string[] = []): {
	store: ApprovalConfigStore & { added: string[]; alwaysAllow: string[] };
} {
	const store = {
		alwaysAllow: [...initial],
		added: [] as string[],
		getAlwaysAllow(): string[] {
			return store.alwaysAllow;
		},
		async addAlwaysAllow(name: string): Promise<void> {
			store.added.push(name);
			store.alwaysAllow.push(name);
		},
	};
	return { store };
}

describe('ApprovalGateway', () => {
	it('shouldGate: read 免审批，其余需审批', () => {
		const gw = new ApprovalGateway();
		assert.strictEqual(gw.shouldGate('read'), false);
		assert.strictEqual(gw.shouldGate('write'), true);
		assert.strictEqual(gw.shouldGate('execute'), true);
		assert.strictEqual(gw.shouldGate('destructive'), true);
	});

	it('命中 alwaysAllow 配置则不弹窗直接放行', async () => {
		const { store } = mockStore(['fs.write_file']);
		const { prompter, calls } = mockPrompter(['deny']);
		const gw = new ApprovalGateway({ prompter, store });
		// Act
		const decision = await gw.requestApproval(
			'fs.write_file',
			'写入 src/x.ts',
			'sess-1'
		);
		// Assert
		assert.strictEqual(decision, 'allow');
		assert.strictEqual(calls.length, 0); // 未弹窗
	});

	it('用户选「允许」记入会话级，同 session 同工具不再弹窗', async () => {
		const { store } = mockStore();
		const { prompter, calls } = mockPrompter(['allow']);
		const gw = new ApprovalGateway({ prompter, store });
		// 第一次：弹窗 -> allow
		const d1 = await gw.requestApproval('fs.write_file', '写入 a', 'sess-1');
		assert.strictEqual(d1, 'allow');
		assert.strictEqual(calls.length, 1);
		// 第二次：会话级命中，不弹窗
		const d2 = await gw.requestApproval('fs.write_file', '写入 b', 'sess-1');
		assert.strictEqual(d2, 'allow');
		assert.strictEqual(calls.length, 1);
	});

	it('会话级允许不跨 session', async () => {
		const { store } = mockStore();
		const { prompter, calls } = mockPrompter(['allow', 'deny']);
		const gw = new ApprovalGateway({ prompter, store });
		await gw.requestApproval('fs.write_file', '写入 a', 'sess-1');
		// 新 session：不命中会话级，重新弹窗
		const d2 = await gw.requestApproval('fs.write_file', '写入 b', 'sess-2');
		assert.strictEqual(d2, 'deny');
		assert.strictEqual(calls.length, 2);
	});

	it('用户选「始终允许」写入配置并持久放行', async () => {
		const { store } = mockStore();
		const { prompter } = mockPrompter(['always', undefined]);
		const gw = new ApprovalGateway({ prompter, store });
		// 第一次：弹窗 -> always，写入配置
		const d1 = await gw.requestApproval('fs.move_file', '移动 a', 'sess-1');
		assert.strictEqual(d1, 'always');
		assert.deepStrictEqual(store.added, ['fs.move_file']);
		// 第二次：持久允许命中，不弹窗
		const d2 = await gw.requestApproval('fs.move_file', '移动 b', 'sess-2');
		assert.strictEqual(d2, 'allow');
	});

	it('用户拒绝（deny/关闭）返回 deny', async () => {
		const { store } = mockStore();
		const { prompter } = mockPrompter([undefined]); // 关闭弹窗
		const gw = new ApprovalGateway({ prompter, store });
		const decision = await gw.requestApproval(
			'fs.delete_file',
			'删除 a',
			'sess-1'
		);
		assert.strictEqual(decision, 'deny');
	});

	it('clearSession 清理会话级允许记忆', async () => {
		const { store } = mockStore();
		const { prompter, calls } = mockPrompter(['allow', 'deny']);
		const gw = new ApprovalGateway({ prompter, store });
		await gw.requestApproval('fs.write_file', '写入 a', 'sess-1');
		gw.clearSession('sess-1');
		// 清理后同 session 同工具重新弹窗
		const d = await gw.requestApproval('fs.write_file', '写入 b', 'sess-1');
		assert.strictEqual(d, 'deny');
		assert.strictEqual(calls.length, 2);
	});

	it('无 sessionId 时「允许」仅本次放行（不记忆），下次仍弹窗', async () => {
		const { store } = mockStore();
		const { prompter, calls } = mockPrompter(['allow', 'deny']);
		const gw = new ApprovalGateway({ prompter, store });
		await gw.requestApproval('fs.write_file', '写入 a');
		const d2 = await gw.requestApproval('fs.write_file', '写入 b');
		assert.strictEqual(d2, 'deny');
		assert.strictEqual(calls.length, 2);
	});

	it('destructive 操作即使已允许仍要求二次确认', async () => {
		const { store } = mockStore();
		const { prompter, calls } = mockPrompter(['allow', 'allow']);
		const gw = new ApprovalGateway({ prompter, store });
		const decision = await gw.requestDestructiveApproval('fs.delete_file', '删除 a', 'sess-1');
		assert.strictEqual(decision, 'allow');
		assert.strictEqual(calls.length, 2);
	});
});
