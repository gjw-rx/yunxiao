/**
 * 会话归档 repository 测试（v2 版本化归档契约）。
 * 覆盖：header 校验、追加 Entry 索引、活动位置跨重启恢复、父链循环、
 * 重复 ID、悬挂父引用、损坏 compaction 边界与非活动路径投影隔离。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ArchiveEntry, SessionHeader, SessionRecord, UserMessage } from '../../memory/types';
import { SESSION_ARCHIVE_VERSION } from '../../memory/types';
import { loadArchive, projectActiveMessages, getActiveCompactionPoint, validateArchive } from '../../memory/sessionArchive';

/** 构造一条 message Entry 的工具函数。 */
function messageEntry(id: string, parentId: string | null, recordSeq: number, role: 'user' | 'assistant' = 'user'): ArchiveEntry {
	const message = role === 'user'
		? { role: 'user' as const, content: `内容-${id}`, seq: recordSeq - 1 }
		: { role: 'assistant' as const, content: `回复-${id}`, seq: recordSeq - 1 };
	return {
		type: 'entry',
		kind: 'message',
		id,
		parentId,
		recordSeq,
		timestamp: new Date(2026, 0, 1).toISOString(),
		payload: { kind: 'message', message },
	};
}

/** 构造 head_update Entry 的工具函数。 */
function headUpdateEntry(id: string, parentId: string | null, recordSeq: number, headEntryId: string): ArchiveEntry {
	return {
		type: 'entry',
		kind: 'head_update',
		id,
		parentId,
		recordSeq,
		timestamp: new Date(2026, 0, 1).toISOString(),
		payload: { kind: 'head_update', headEntryId },
	};
}

/** 构造 compaction Entry 的工具函数。 */
function compactionEntry(id: string, parentId: string | null, recordSeq: number, firstKeptEntryId: string): ArchiveEntry {
	return {
		type: 'entry',
		kind: 'compaction',
		id,
		parentId,
		recordSeq,
		timestamp: new Date(2026, 0, 1).toISOString(),
		payload: { kind: 'compaction', summary: `摘要-${id}`, firstKeptEntryId },
	};
}

/** 构造合法 session header 的工具函数。 */
function makeHeader(sessionId: string): SessionHeader {
	return {
		type: 'session',
		version: SESSION_ARCHIVE_VERSION,
		sessionId,
		createdAt: new Date(2026, 0, 1).toISOString(),
		workspacePath: '/Users/test/ws',
	};
}

describe('SessionArchiveRepository', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-archive-test-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe('validateArchive', () => {
		it('校验合法 v2 header 与追加 Entry，建立 ID/序号索引与线性活动路径', () => {
			const records: SessionRecord[] = [
				makeHeader('s1'),
				messageEntry('e1', null, 1),
				messageEntry('e2', 'e1', 2),
				messageEntry('e3', 'e2', 3),
			];
			const archive = validateArchive(records, 's1');
			assert.strictEqual(archive.corrupt, false);
			assert.deepStrictEqual(archive.diagnostics, []);
			assert.strictEqual(archive.header?.version, SESSION_ARCHIVE_VERSION);
			assert.strictEqual(archive.entries.length, 3);
			assert.strictEqual(archive.byId.get('e2')?.recordSeq, 2);
			assert.strictEqual(archive.bySeq.get(3)?.id, 'e3');
			assert.strictEqual(archive.headEntryId, 'e3');
			assert.deepStrictEqual(
				archive.activePath.map((entry) => entry.id),
				['e1', 'e2', 'e3'],
			);
		});

		it('重复 ID 标记损坏', () => {
			const records: SessionRecord[] = [
				makeHeader('s1'),
				messageEntry('e1', null, 1),
				messageEntry('e1', 'e1', 2),
			];
			const archive = validateArchive(records, 's1');
			assert.strictEqual(archive.corrupt, true);
			assert.ok(archive.diagnostics.some((d) => d.code === 'duplicate-id'));
		});

		it('recordSeq 重复或未严格递增标记损坏', () => {
			const records: SessionRecord[] = [
				makeHeader('s1'),
				messageEntry('e1', null, 1),
				messageEntry('e2', 'e1', 1),
			];
			const archive = validateArchive(records, 's1');
			assert.strictEqual(archive.corrupt, true);
			assert.ok(archive.diagnostics.some((d) => d.code === 'duplicate-seq'));
		});

		it('悬挂父引用标记损坏', () => {
			const records: SessionRecord[] = [
				makeHeader('s1'),
				messageEntry('e1', null, 1),
				messageEntry('e2', 'missing-parent', 2),
			];
			const archive = validateArchive(records, 's1');
			assert.strictEqual(archive.corrupt, true);
			assert.ok(archive.diagnostics.some((d) => d.code === 'broken-parent'));
		});

		it('父链循环标记损坏', () => {
			const records: SessionRecord[] = [
				makeHeader('s1'),
				messageEntry('e1', 'e3', 1),
				messageEntry('e2', 'e1', 2),
				messageEntry('e3', 'e2', 3),
			];
			const archive = validateArchive(records, 's1');
			assert.strictEqual(archive.corrupt, true);
			assert.ok(archive.diagnostics.some((d) => d.code === 'cycle'));
		});

		it('缺失 header 标记损坏', () => {
			const records: SessionRecord[] = [messageEntry('e1', null, 1)];
			const archive = validateArchive(records, 's1');
			assert.strictEqual(archive.corrupt, true);
			assert.ok(archive.diagnostics.some((d) => d.code === 'missing-header'));
		});

		it('版本不匹配标记损坏', () => {
			const records: SessionRecord[] = [
				{ ...makeHeader('s1'), version: 99 },
				messageEntry('e1', null, 1),
			];
			const archive = validateArchive(records, 's1');
			assert.strictEqual(archive.corrupt, true);
			assert.ok(archive.diagnostics.some((d) => d.code === 'bad-header'));
		});

		it('活动位置（head_update）跨重启恢复，并从该位置构建活动路径', () => {
			// 模拟回滚后：e1..e4 线性追加，随后 head_update 将活动位置移回 e2
			const records: SessionRecord[] = [
				makeHeader('s1'),
				messageEntry('e1', null, 1),
				messageEntry('e2', 'e1', 2),
				messageEntry('e3', 'e2', 3),
				messageEntry('e4', 'e3', 4),
				headUpdateEntry('h1', 'e4', 5, 'e2'),
			];
			const archive = validateArchive(records, 's1');
			assert.strictEqual(archive.corrupt, false);
			assert.strictEqual(archive.headEntryId, 'e2');
			assert.deepStrictEqual(
				archive.activePath.map((entry) => entry.id),
				['e1', 'e2'],
			);
		});

		it('head_update 指向不存在的 Entry 标记损坏', () => {
			const records: SessionRecord[] = [
				makeHeader('s1'),
				messageEntry('e1', null, 1),
				messageEntry('e2', 'e1', 2),
				headUpdateEntry('h1', 'e2', 3, 'missing-head'),
			];
			const archive = validateArchive(records, 's1');
			assert.strictEqual(archive.corrupt, true);
			assert.ok(archive.diagnostics.some((d) => d.code === 'bad-head'));
		});

		it('损坏 compaction 边界（指向不存在或路径外 Entry）标记损坏', () => {
			const records: SessionRecord[] = [
				makeHeader('s1'),
				messageEntry('e1', null, 1),
				messageEntry('e2', 'e1', 2),
				compactionEntry('c1', 'e2', 3, 'missing-boundary'),
			];
			const archive = validateArchive(records, 's1');
			assert.strictEqual(archive.corrupt, true);
			assert.ok(archive.diagnostics.some((d) => d.code === 'bad-compaction-boundary'));
		});

		it('压缩边界指向路径外 Entry 标记损坏（边界存在于归档但不属于活动路径）', () => {
			// e3 是另一分支（父链 e1→e2→e3），c1 挂在 e2 下且边界指向 e3：
			// c1 在活动路径（e1→e2→c1）上，但 firstKeptEntryId=e3 不在该路径
			const records: SessionRecord[] = [
				makeHeader('s1'),
				messageEntry('e1', null, 1),
				messageEntry('e2', 'e1', 2),
				messageEntry('e3', 'e2', 3),
				compactionEntry('c1', 'e2', 4, 'e3'),
				headUpdateEntry('h1', 'c1', 5, 'c1'),
			];
			const archive = validateArchive(records, 's1');
			assert.strictEqual(archive.corrupt, true);
			assert.ok(archive.diagnostics.some((d) => d.code === 'bad-compaction-boundary'));
		});
	});

	describe('loadArchive', () => {
		it('文件不存在返回空归档且不抛异常', () => {
			const archive = loadArchive(path.join(tmpDir, 'no-such.jsonl'), 's1');
			assert.strictEqual(archive.entries.length, 0);
			assert.strictEqual(archive.corrupt, true);
		});

		it('坏行跳过并产生诊断，不覆盖源文件', () => {
			const file = path.join(tmpDir, 's1.jsonl');
			fs.writeFileSync(file, `${JSON.stringify(makeHeader('s1'))}\nnot-json\n${JSON.stringify(messageEntry('e1', null, 1))}\n`, 'utf8');
			const archive = loadArchive(file, 's1');
			assert.strictEqual(archive.corrupt, true);
			assert.strictEqual(archive.entries.length, 1);
			assert.ok(archive.diagnostics.some((d) => d.code === 'bad-line'));
			// 源文件保持不变
			assert.strictEqual(fs.readFileSync(file, 'utf8').split('\n').length, 4);
		});
	});

	describe('投影隔离', () => {
		it('非活动路径的合法 Entry 不进入消息投影', () => {
			const records: SessionRecord[] = [
				makeHeader('s1'),
				messageEntry('e1', null, 1),
				messageEntry('e2', 'e1', 2),
				messageEntry('e3', 'e2', 3),
				messageEntry('e4', 'e3', 4),
				headUpdateEntry('h1', 'e4', 5, 'e2'),
			];
			const archive = validateArchive(records, 's1');
			const messages = projectActiveMessages(archive);
			// 仅 e1/e2 在活动路径上（seq 0/1）
			assert.deepStrictEqual(
				messages.map((m) => (m as UserMessage).content),
				['内容-e1', '内容-e2'],
			);
		});

		it('getActiveCompactionPoint 返回活动路径上的最新压缩检查点', () => {
			const records: SessionRecord[] = [
				makeHeader('s1'),
				messageEntry('e1', null, 1),
				messageEntry('e2', 'e1', 2),
				compactionEntry('c1', 'e2', 3, 'e1'),
				messageEntry('e3', 'c1', 4),
				compactionEntry('c2', 'e3', 5, 'e3'),
			];
			const archive = validateArchive(records, 's1');
			const point = getActiveCompactionPoint(archive);
			assert.ok(point);
			assert.strictEqual(point!.summary, '摘要-c2');
			assert.strictEqual(point!.firstKeptEntryId, 'e3');
		});
	});
});