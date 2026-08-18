/**
 * 用量统计单元测试：自然日/周/月边界、按模型聚合、缓存明细、未知模型、
 * 回滚记录计入、无 token 旧消息忽略与局部归档损坏 partial 标记。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionFileStore } from '../../memory/sessionFileStore';
import {
	aggregateTokenUsage,
	computeRange,
	UNKNOWN_MODEL_KEY,
	UNKNOWN_MODEL_LABEL,
} from '../../memory/tokenUsageStats';
import type { ArchivedTokenRecord } from '../../memory/sessionFileStore';

/** 构造一条已落账 token 记录。 */
function record(
	overrides: Partial<ArchivedTokenRecord> & { timestamp: string },
): ArchivedTokenRecord {
	return {
		sessionId: 's1',
		tokenUsage: {
			prompt_tokens: 100,
			completion_tokens: 20,
			total_tokens: 120,
			reasoning: 0,
			tool_calls: 0,
			model_output: 20,
			user_input: 100,
			context: 0,
			source: 'usage',
			provider_id: 'openai',
			model_id: 'gpt-4o-mini',
			model_label: 'gpt-4o-mini',
		},
		...overrides,
	};
}

describe('computeRange 自然边界', () => {
	it('自然日：本地 00:00 至次日 00:00', () => {
		const ref = new Date(2026, 7, 15, 14, 30, 0); // 2026-08-15 14:30 本地时间
		const { start, end } = computeRange('day', ref);
		assert.strictEqual(start.getFullYear(), 2026);
		assert.strictEqual(start.getMonth(), 7);
		assert.strictEqual(start.getDate(), 15);
		assert.strictEqual(start.getHours(), 0);
		assert.strictEqual(end.getDate(), 16);
		assert.strictEqual(end.getHours(), 0);
	});

	it('自然周：从周一开始', () => {
		// 2026-08-15 是周六；所在周应为 2026-08-10（周一）
		const ref = new Date(2026, 7, 15, 20, 0, 0);
		const { start, end } = computeRange('week', ref);
		assert.strictEqual(start.getDay(), 1, '周起点应为周一');
		assert.strictEqual(start.getDate(), 10);
		assert.strictEqual(end.getDate(), 17);
		assert.strictEqual(end.getDay(), 1);
	});

	it('自然月：当月第一天至下月第一天', () => {
		const ref = new Date(2026, 7, 31, 23, 59, 0); // 8 月最后一天
		const { start, end } = computeRange('month', ref);
		assert.strictEqual(start.getDate(), 1);
		assert.strictEqual(start.getMonth(), 7);
		assert.strictEqual(end.getDate(), 1);
		assert.strictEqual(end.getMonth(), 8);
	});

	it('周一 00:00 属于新一周（左闭右开边界）', () => {
		// 2026-08-10 是周一：day 起点后 end 前
		const ref = new Date(2026, 7, 10, 0, 0, 0);
		const { start, end } = computeRange('day', ref);
		assert.strictEqual(start.getTime(), ref.getTime());
		assert.ok(ref.getTime() >= start.getTime() && ref.getTime() < end.getTime());
	});
});

describe('aggregateTokenUsage 聚合', () => {
	const base = { scannedCount: 2, corruptSessions: [] as string[] };

	it('多个模型分别求和，同模型账相加不混合', () => {
		const records = [
			record({ timestamp: '2026-08-15T02:00:00.000Z', tokenUsage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, reasoning: 0, tool_calls: 0, model_output: 20, user_input: 100, context: 0, source: 'usage', provider_id: 'openai', model_id: 'gpt-4o-mini', model_label: 'gpt-4o-mini' } }),
			record({ timestamp: '2026-08-15T03:00:00.000Z', tokenUsage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, reasoning: 0, tool_calls: 0, model_output: 10, user_input: 50, context: 0, source: 'usage', provider_id: 'openai', model_id: 'gpt-4o-mini', model_label: 'gpt-4o-mini' } }),
			record({ timestamp: '2026-08-15T04:00:00.000Z', tokenUsage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240, reasoning: 0, tool_calls: 0, model_output: 40, user_input: 200, context: 0, source: 'usage', provider_id: 'openai', model_id: 'gpt-4o', model_label: 'gpt-4o' } }),
		];
		const result = aggregateTokenUsage({ ...base, records }, 'day', new Date(2026, 7, 15));
		assert.strictEqual(result.models.length, 2);
		const mini = result.models.find((m) => m.model_id === 'gpt-4o-mini')!;
		assert.strictEqual(mini.total_tokens, 180); // 120 + 60
		const gpt4 = result.models.find((m) => m.model_id === 'gpt-4o')!;
		assert.strictEqual(gpt4.total_tokens, 240);
		assert.strictEqual(result.total_tokens, 420);
	});

	it('缓存明细不重复计入 total', () => {
		const records = [
			record({
				timestamp: '2026-08-15T02:00:00.000Z',
				tokenUsage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 150, reasoning: 0, tool_calls: 0, model_output: 20, user_input: 100, context: 0, source: 'usage', provider_id: 'openai', model_id: 'gpt-4o-mini', model_label: 'gpt-4o-mini', cache_read_tokens: 80, no_cache_tokens: 20 } as ArchivedTokenRecord['tokenUsage'],
			}),
		];
		const result = aggregateTokenUsage({ ...base, records }, 'day', new Date(2026, 7, 15));
		const row = result.models[0];
		assert.strictEqual(row.total_tokens, 150, 'total 只取 total_tokens，不叠加缓存');
		assert.strictEqual(row.cache_read_tokens, 80, '缓存读取作为输入侧明细独立累计');
		assert.strictEqual(row.no_cache_tokens, 20);
		assert.strictEqual(result.total_tokens, 150);
	});

	it('日边界左闭右开：次日 00:00 的账进入下一自然日', () => {
		const records = [
			record({ timestamp: '2026-08-15T16:00:00.000Z' }),
			record({ timestamp: '2026-08-16T00:00:00.000Z' }), // 边界时刻 UTC 可能落在本地同日
		];
		// 用一个本地时刻确定日界：reference 为本地 8/15，UTC 8/16 00:00 在本地仍是 8/15
		const dayStart = new Date(2026, 7, 15).getTime();
		const dayEnd = new Date(2026, 7, 16).getTime();
		const inDay = records.filter((r) => {
			const t = new Date(r.timestamp).getTime();
			return t >= dayStart && t < dayEnd;
		});
		// 断言按边界函数判断结果与直接区间判断一致（验证实现不外溢）
		const result = aggregateTokenUsage({ ...base, records }, 'day', new Date(2026, 7, 15));
		assert.strictEqual(result.total_tokens, inDay.reduce((s, r) => s + r.tokenUsage.total_tokens, 0));
	});

	it('未知模型归入固定分组，不按当前默认模型猜测', () => {
		const records = [
			record({ timestamp: '2026-08-15T02:00:00.000Z' }),
			record({
				timestamp: '2026-08-15T03:00:00.000Z',
				tokenUsage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35, reasoning: 0, tool_calls: 0, model_output: 5, user_input: 30, context: 0, source: 'usage' } as ArchivedTokenRecord['tokenUsage'],
			}),
		];
		const result = aggregateTokenUsage({ ...base, records }, 'day', new Date(2026, 7, 15));
		const unknown = result.models.find((m) => m.model_id === UNKNOWN_MODEL_KEY);
		assert.ok(unknown, '缺少模型元数据的账应归入未知模型');
		assert.strictEqual(unknown!.provider_id, UNKNOWN_MODEL_KEY);
		assert.strictEqual(unknown!.model_label, UNKNOWN_MODEL_LABEL);
		assert.strictEqual(unknown!.total_tokens, 35);
	});

	it('无 token 旧消息不产生估算账', () => {
		// 无 tokenUsage 的记录不存在于扫描结果中，聚合不得凭空生成账
		const records: ArchivedTokenRecord[] = [];
		const result = aggregateTokenUsage({ ...base, records }, 'day', new Date(2026, 7, 15));
		assert.strictEqual(result.total_tokens, 0);
		assert.strictEqual(result.models.length, 0);
		assert.strictEqual(result.partial, false);
	});

	it('局部归档损坏时标记 partial 并保留其余统计', () => {
		const records = [record({ timestamp: '2026-08-15T02:00:00.000Z' })];
		const result = aggregateTokenUsage(
			{ ...base, records, corruptSessions: ['s-broken'] },
			'day',
			new Date(2026, 7, 15),
		);
		assert.strictEqual(result.partial, true);
		assert.strictEqual(result.total_tokens, records[0].tokenUsage.total_tokens);
		assert.strictEqual(result.models.length, 1);
	});

	it('周/月聚合只包含对应区间账目', () => {
		// 用本地时间构造时间戳，避免机器时区差异导致分桶偏差
		const records = [
			record({ timestamp: new Date(2026, 7, 10, 0, 30).toISOString() }), // 周一凌晨（本周）
			record({ timestamp: new Date(2026, 7, 9, 23, 59).toISOString() }), // 上周日（区间外）
			record({ timestamp: new Date(2026, 7, 16, 23, 59).toISOString() }), // 本周日（周一自然周含周日，仍在本周）
		];
		const week = aggregateTokenUsage({ ...base, records }, 'week', new Date(2026, 7, 12)); // 周三
		// 本周：周一凌晨 + 本周日（周六/周日属于周一开启的自然周）；上周日被排除
		assert.strictEqual(week.total_tokens, records[0].tokenUsage.total_tokens + records[2].tokenUsage.total_tokens, '周内只含周一至周日');
	});
});

describe('SessionFileStore 归档 token 扫描', () => {
	let baseDir: string;
	let store: SessionFileStore;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-token-scan-'));
		store = new SessionFileStore('/tmp/workspace', baseDir);
	});

	afterEach(async () => {
		await store.flush();
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	/** 构造带 tokenUsage 的 assistant 消息。 */
	function assistantWithUsage(seq: number, modelId: string, total: number): Record<string, unknown> {
		return {
			role: 'assistant',
			content: 'reply',
			seq,
			tokenUsage: {
				prompt_tokens: 100,
				completion_tokens: 10,
				total_tokens: total,
				reasoning: 0,
				tool_calls: 0,
				model_output: 10,
				user_input: 100,
				context: 0,
				source: 'usage',
				provider_id: 'openai',
				model_id: modelId,
				model_label: modelId,
			},
		};
	}

	it('每个已落账调用只返回一次，且回滚记录仍计入', async () => {
		store.createSession('s1');
		store.appendMessage('s1', { role: 'user', content: 'hi', seq: 0 });
		store.appendMessage('s1', assistantWithUsage(1, 'model-a', 120) as never);
		store.appendMessage('s1', assistantWithUsage(2, 'model-b', 60) as never);
		await store.flush();

		// 回滚模型 B 所在消息（head 指向第一条 assistant 之后的 user 消息物理记录）
		const archive = store.readArchive('s1');
		const firstAssistant = archive.entries.find((e) => e.kind === 'message' && (e.payload as { message?: { seq: number } }).message?.seq === 1);
		assert.ok(firstAssistant);
		store.appendHeadUpdate('s1', firstAssistant!.id);
		await store.flush();

		const { records, corruptSessions } = store.scanTokenRecords();
		assert.strictEqual(records.length, 2, '回滚不撤销物理落账，两笔均计入且各一次');
		assert.deepStrictEqual(
			records.map((r) => r.tokenUsage.model_id).sort(),
			['model-a', 'model-b'],
		);
		assert.strictEqual(records.filter((r) => r.tokenUsage.model_id === 'model-a').length, 1);
		assert.strictEqual(corruptSessions.length, 0);
	});

	it('无 tokenUsage 的旧 assistant 消息被忽略', async () => {
		store.createSession('s1');
		store.appendMessage('s1', { role: 'user', content: 'hi', seq: 0 });
		store.appendMessage('s1', { role: 'assistant', content: 'old reply', seq: 1 });
		store.appendMessage('s1', assistantWithUsage(2, 'model-a', 120) as never);
		await store.flush();

		const { records } = store.scanTokenRecords();
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0].tokenUsage.model_id, 'model-a');
	});

	it('局部归档损坏：损坏会话被跳过并标记，其余会话仍返回', async () => {
		store.createSession('s1');
		store.appendMessage('s1', assistantWithUsage(0, 'model-a', 120) as never);
		await store.flush();
		// 手工制造第二个损坏归档
		fs.writeFileSync(path.join(store.sessionDirPath, 's-broken.jsonl'), '{"type":"session","version":2,"sessionId":"s-broken"}\n{broken json\n', 'utf8');

		const { records, corruptSessions, scannedCount } = store.scanTokenRecords();
		assert.strictEqual(records.length, 1, '有效会话的账目仍返回');
		assert.deepStrictEqual(corruptSessions, ['s-broken']);
		assert.strictEqual(scannedCount, 2);
	});
});