/**
 * 会话归档 repository - 读取并校验版本化 SessionRecord JSONL（v2）。
 * 职责：
 * - 按 workspace 读取完整归档（header + 追加 Entry 列表）；
 * - 校验 header、Entry ID 唯一性、recordSeq 单调递增、父链无环、活动位置与压缩边界；
 * - 建立 ID 与物理序号索引；
 * - 提供完整归档、活动路径与 LLM 上下文三层投影。
 * 损坏记录只产生诊断并保留源文件，不得静默改写未知损坏原件。
 */
import * as fs from 'fs';
import type { ArchiveEntry, CompactionEntryPayload, Message, MessageEntryPayload, SessionRecord, SessionHeader } from './types';
import { SESSION_ARCHIVE_VERSION } from './types';
import * as logger from '../logger';

/** 归档诊断代码：标识具体损坏类别。 */
export type ArchiveDiagnosticCode =
	| 'missing-header'
	| 'bad-header'
	| 'bad-line'
	| 'duplicate-id'
	| 'duplicate-seq'
	| 'broken-parent'
	| 'cycle'
	| 'bad-head'
	| 'bad-compaction-boundary';

/** 归档诊断（会话 ID + 记录位置 + 原因）。 */
export interface ArchiveDiagnostic {
	/** 诊断类别。 */
	readonly code: ArchiveDiagnosticCode;
	/** 记录位置描述（header / recordSeq=.. / 行号）。 */
	readonly location: string;
	/** 中文原因描述。 */
	readonly detail: string;
}

/** 归档校验结果：完整归档 + ID/序号索引 + 活动路径 + 损坏标记。 */
export interface ValidatedArchive {
	/** 会话 ID。 */
	readonly sessionId: string;
	/** 全部原始记录（header + entries，按物理顺序）。 */
	readonly records: SessionRecord[];
	/** session header（缺失时为 undefined，归档视为损坏）。 */
	readonly header?: SessionHeader;
	/** 全部合法 Entry（按 recordSeq 升序）。 */
	readonly entries: ArchiveEntry[];
	/** 诊断列表（可能为空）。 */
	readonly diagnostics: ArchiveDiagnostic[];
	/** 是否存在损坏：为 true 时不得将上下文交给 LLM。 */
	readonly corrupt: boolean;
	/** ID -> Entry 索引。 */
	readonly byId: Map<string, ArchiveEntry>;
	/** recordSeq -> Entry 索引。 */
	readonly bySeq: Map<number, ArchiveEntry>;
	/** 活动 Entry ID（最新 head_update 或最后一条 Entry；无法确定时为 undefined）。 */
	readonly headEntryId?: string;
	/** 活动路径（根到叶顺序）；损坏或无法构建时为空数组。 */
	readonly activePath: ArchiveEntry[];
}

/** 活动路径上的最新压缩检查点（摘要 + 保留边界）。 */
export interface ActiveCompactionPoint {
	/** 增量摘要文本。 */
	readonly summary: string;
	/** 保留原文边界 Entry ID。 */
	readonly firstKeptEntryId: string;
	/** 活跃任务上下文（可选）。 */
	readonly todoContext?: string;
}

/**
 * 校验会话归档记录集合，构建索引与活动路径。
 * 规则：首条记录 MUST 为合法 session header；Entry ID MUST 唯一；recordSeq MUST 严格递增；
 * parentId MUST 引用已存在 ID 且无环；活动位置 MUST 指向存在的 Entry；
 * 活动路径上的 compaction 边界 MUST 指向该路径内已存在的 Entry。
 * @param records 从 JSONL 解析出的原始记录。
 * @param sessionId 会话 ID（用于 header 匹配与日志）。
 * @returns 校验结果（含诊断、索引、活动路径与损坏标记）。
 */
export function validateArchive(records: SessionRecord[], sessionId: string): ValidatedArchive {
	const diagnostics: ArchiveDiagnostic[] = [];
	const entries: ArchiveEntry[] = [];
	const byId = new Map<string, ArchiveEntry>();
	const bySeq = new Map<number, ArchiveEntry>();
	let header: SessionHeader | undefined;
	let corrupt = false;

	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (record.type === 'session') {
			if (i !== 0) {
				diagnostics.push({ code: 'bad-header', location: `记录#${i}`, detail: 'session header 必须是归档首条记录' });
				corrupt = true;
				continue;
			}
			if (record.version !== SESSION_ARCHIVE_VERSION) {
				diagnostics.push({ code: 'bad-header', location: 'header', detail: `不支持的归档版本 version=${record.version}，期望 ${SESSION_ARCHIVE_VERSION}` });
				corrupt = true;
				continue;
			}
			if (record.sessionId !== sessionId) {
				diagnostics.push({ code: 'bad-header', location: 'header', detail: `header 会话 ID 与文件名不一致 ${record.sessionId} != ${sessionId}` });
				corrupt = true;
				continue;
			}
			header = record;
			continue;
		}
		const entry = record as ArchiveEntry;
		if (byId.has(entry.id)) {
			diagnostics.push({ code: 'duplicate-id', location: `recordSeq=${entry.recordSeq}`, detail: `重复 Entry ID ${entry.id}` });
			corrupt = true;
			continue;
		}
		if (bySeq.has(entry.recordSeq)) {
			diagnostics.push({ code: 'duplicate-seq', location: `recordSeq=${entry.recordSeq}`, detail: `重复物理序号 ${entry.recordSeq}` });
			corrupt = true;
			continue;
		}
		const previousSeq = entries.length > 0 ? entries[entries.length - 1].recordSeq : 0;
		if (entry.recordSeq <= previousSeq) {
			diagnostics.push({ code: 'duplicate-seq', location: `recordSeq=${entry.recordSeq}`, detail: `物理序号未严格递增（前序=${previousSeq}）` });
			corrupt = true;
			continue;
		}
		byId.set(entry.id, entry);
		bySeq.set(entry.recordSeq, entry);
		entries.push(entry);
	}

	if (!header) {
		diagnostics.unshift({ code: 'missing-header', location: '归档首行', detail: '缺少合法 session header，无法识别会话归档' });
		corrupt = true;
	}

	// 父引用与环检测：parentId 必须引用已存在 ID，且沿父链回溯不得成环。
	for (const entry of entries) {
		if (entry.parentId === null) {
			continue;
		}
		const parent = byId.get(entry.parentId);
		if (!parent) {
			diagnostics.push({ code: 'broken-parent', location: `recordSeq=${entry.recordSeq}`, detail: `父引用指向不存在的 ID ${entry.parentId}` });
			corrupt = true;
			continue;
		}
		if (hasCycle(entry, byId)) {
			diagnostics.push({ code: 'cycle', location: `recordSeq=${entry.recordSeq}`, detail: `父链成环（起点 ${entry.id}）` });
			corrupt = true;
		}
	}

	// 活动位置：取最新 head_update 的 headEntryId；无 head_update 时取最后一条 Entry（线性历史）。
	let headEntryId: string | undefined;
	let headExplicitlyEmpty = false;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.kind === 'head_update') {
			const head = (entry.payload as { headEntryId: string | null }).headEntryId;
			if (head === null) {
				// 显式空活动路径（回滚到会话开头）
				headExplicitlyEmpty = true;
				break;
			}
			if (!byId.has(head)) {
				diagnostics.push({ code: 'bad-head', location: `recordSeq=${entry.recordSeq}`, detail: `活动位置指向不存在的 Entry ${head}` });
				corrupt = true;
				break;
			}
			headEntryId = head;
			break;
		}
	}
	if (!headExplicitlyEmpty && !headEntryId && entries.length > 0) {
		headEntryId = entries[entries.length - 1].id;
	}
	if (headEntryId && !byId.has(headEntryId)) {
		corrupt = true;
	}

	// 活动路径：从活动位置沿 parentId 回溯到根，再反转为根到叶。
	let activePath: ArchiveEntry[] = [];
	if (headEntryId && !corrupt) {
		const path: ArchiveEntry[] = [];
		const visited = new Set<string>();
		let cursor: ArchiveEntry | undefined = byId.get(headEntryId);
		while (cursor) {
			if (visited.has(cursor.id)) {
				diagnostics.push({ code: 'cycle', location: `head=${headEntryId}`, detail: `活动路径成环（${cursor.id}）` });
				corrupt = true;
				activePath = [];
				break;
			}
			visited.add(cursor.id);
			path.push(cursor);
			cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
		}
		if (!corrupt) {
			activePath = path.reverse();
		}
	}

	// 压缩边界校验：活动路径上的 compaction 边界必须指向路径内已存在的 Entry。
	if (activePath.length > 0) {
		const pathIds = new Set(activePath.map((entry) => entry.id));
		for (const entry of activePath) {
			if (entry.kind === 'compaction') {
				const firstKept = (entry.payload as CompactionEntryPayload).firstKeptEntryId;
				if (!byId.has(firstKept) || !pathIds.has(firstKept)) {
					diagnostics.push({ code: 'bad-compaction-boundary', location: `recordSeq=${entry.recordSeq}`, detail: `压缩边界指向路径外或不存在的 Entry ${firstKept}` });
					corrupt = true;
				}
			}
		}
	}

	if (corrupt) {
		for (const diagnostic of diagnostics) {
			logger.error(`[SessionArchive] 归档损坏 sessionId=${sessionId} code=${diagnostic.code} location=${diagnostic.location} detail=${diagnostic.detail}`);
		}
	}
	return { sessionId, records, header, entries, diagnostics, corrupt, byId, bySeq, headEntryId, activePath };
}

/**
 * 读取并校验会话归档文件；文件不存在返回空归档（不报错）。
 * @param filePath 会话 JSONL 文件绝对路径。
 * @param sessionId 会话 ID。
 * @returns 校验后的归档。
 */
export function loadArchive(filePath: string, sessionId: string): ValidatedArchive {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, 'utf8');
	} catch {
		logger.log(`[SessionArchive] 归档文件不存在 sessionId=${sessionId} file=${filePath}`);
		return { sessionId, records: [], entries: [], diagnostics: [], corrupt: true, byId: new Map(), bySeq: new Map(), activePath: [] };
	}
	const records: SessionRecord[] = [];
	const diagnostics: ArchiveDiagnostic[] = [];
	const lines = raw.split('\n');
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		if (!line.trim()) {
			continue;
		}
		try {
			records.push(JSON.parse(line) as SessionRecord);
		} catch {
			logger.error(`[SessionArchive] 跳过坏行 sessionId=${sessionId} 行=${lineIndex + 1} 内容=${line.slice(0, 80)}`);
			diagnostics.push({ code: 'bad-line', location: `行${lineIndex + 1}`, detail: `非法 JSON 行：${line.slice(0, 80)}` });
		}
	}
	const validated = validateArchive(records, sessionId);
	// 合并坏行诊断（validateArchive 不感知行级解析失败）
	return {
		...validated,
		diagnostics: [...diagnostics, ...validated.diagnostics],
		corrupt: validated.corrupt || diagnostics.length > 0,
	};
}

/**
 * 从活动路径投影消息列表（LLM 上下文与兼容读取使用）。
 * 仅包含 kind='message' 的 Entry；非活动路径的合法 Entry 不进入结果。
 * @param archive 校验后的归档。
 * @returns 消息数组（按活动路径根到叶顺序，保留 seq 兼容投影）。
 */
export function projectActiveMessages(archive: ValidatedArchive): Message[] {
	return archive.activePath
		.filter((entry): entry is ArchiveEntry & { payload: MessageEntryPayload } => entry.kind === 'message')
		.map((entry) => entry.payload.message);
}

/**
 * 返回活动路径上的最新压缩检查点；无检查点时返回 null。
 * @param archive 校验后的归档。
 * @returns 压缩检查点（摘要 + 边界）或 null。
 */
export function getActiveCompactionPoint(archive: ValidatedArchive): ActiveCompactionPoint | null {
	for (let i = archive.activePath.length - 1; i >= 0; i--) {
		const entry = archive.activePath[i];
		if (entry.kind === 'compaction') {
			const payload = entry.payload as CompactionEntryPayload;
			return { summary: payload.summary, firstKeptEntryId: payload.firstKeptEntryId, todoContext: payload.todoContext };
		}
	}
	return null;
}

/**
 * 沿父链检测是否成环（从 start 出发最多遍历全部 Entry 次数）。
 * @param start 起点 Entry。
 * @param byId ID 索引。
 * @returns 是否存在环。
 */
function hasCycle(start: ArchiveEntry, byId: Map<string, ArchiveEntry>): boolean {
	const visited = new Set<string>();
	let cursor: ArchiveEntry | undefined = start;
	while (cursor) {
		if (visited.has(cursor.id)) {
			return true;
		}
		visited.add(cursor.id);
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
	}
	return false;
}