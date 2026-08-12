/**
 * Webview 全局状态 reducer。
 *
 * 职责：以纯函数方式消费宿主事件（Host → Webview）与本地 UI 动作，
 * 维护聊天消息流（回合模型）、工具时间线、审批卡、Diff 卡与界面状态。
 * 副作用（如 loadHistory 请求）不在 reducer 内执行，由 App 层在订阅回调中触发。
 */
import type {
	ApprovalEntry,
	DiffEntry,
	HistoryEntry,
	SessionMeta,
	SessionTokenPayload,
	SlashCommand,
	SlashCommandGroup,
	ToolEntry,
	ToolState,
	TokenUsageDetail,
	WorkspaceFile,
} from '../protocol';

/** 消息流条目（扁平渲染顺序数组，按 turn 分组渲染）。 */
export type MessageItem =
	| { id: string; kind: 'user'; text: string; turn: number }
	| { id: string; kind: 'assistant'; text: string; streaming: boolean; tokenUsage?: TokenUsageDetail; turn: number }
	| { id: string; kind: 'thought'; text: string; turn: number }
	| { id: string; kind: 'tool'; callId: string; turn: number }
	| { id: string; kind: 'plan'; steps: readonly string[]; turn: number }
	| { id: string; kind: 'approval'; callId: string; turn: number }
	| { id: string; kind: 'diff'; callId: string; turn: number }
	| { id: string; kind: 'compaction'; active: boolean; turn: number };

/** Webview 全局界面状态。 */
export interface ChatState {
	/** 当前会话 ID（未创建/已删除为 null） */
	currentSessionId: string | null;
	/** 当前会话标题（历史切换时回填输入框） */
	sessionTitle: string;
	/** 是否正在流式回复 */
	isStreaming: boolean;
	/** 模型名称 */
	modelName: string;
	/** 斜杠命令分组 */
	slashCommandGroups: SlashCommandGroup[];
	/** 历史会话列表 */
	sessions: SessionMeta[];
	/** 工作区文件（@ 引用候选） */
	workspaceFiles: WorkspaceFile[];
	/** 已引用文件 */
	selectedFiles: WorkspaceFile[];
	/** 已选 Skill */
	selectedSkills: SlashCommand[];
	/** 错误提示文本（5 秒后由 UI 清空） */
	error: string;
	/** 会话级 token 累计 */
	sessionTokenUsage: SessionTokenPayload | null;
	/** 消息流（含过程步骤与回复气泡，按渲染顺序） */
	messages: MessageItem[];
	/** 工具时间线条目：call_id → 条目 */
	toolEntries: Record<string, ToolEntry>;
	/** 审批卡：call_id → 条目 */
	approvals: Record<string, ApprovalEntry>;
	/** Diff 卡：call_id → 条目 */
	diffs: Record<string, DiffEntry>;
	/** 当前回合计数器（用户消息时递增） */
	turnCounter: number;
	/** 当前流式 assistant 消息 id（replyChunk 目标） */
	liveAssistantId: string | null;
	/** 当前思考步骤 id（增量合并目标） */
	liveThoughtId: string | null;
}

/** 初始状态。 */
export const initialState: ChatState = {
	currentSessionId: null,
	sessionTitle: '',
	isStreaming: false,
	modelName: '',
	slashCommandGroups: [],
	sessions: [],
	workspaceFiles: [],
	selectedFiles: [],
	selectedSkills: [],
	error: '',
	sessionTokenUsage: null,
	messages: [],
	toolEntries: {},
	approvals: {},
	diffs: {},
	turnCounter: 0,
	liveAssistantId: null,
	liveThoughtId: null,
};

/** 动作载荷辅助：创建自增消息 id。 */
let idCounter = 0;
function nextId(prefix: string): string {
	idCounter += 1;
	return `${prefix}-${idCounter}`;
}

/** 合并流式文本：增量或累计文本取较全者，避免重复追加。 */
function mergeStreamText(current: string, incoming: string): string {
	if (!incoming) return current;
	if (!current || incoming.startsWith(current)) return incoming;
	if (current.startsWith(incoming) || current.endsWith(incoming)) return current;
	return current + incoming;
}

/** 从工具入参挑一个最有信息量的字段做行内预览。 */
export function summarizeArgs(args: unknown): string {
	if (args === null || typeof args !== 'object') {
		return typeof args === 'string' ? args : '';
	}
	const record = args as Record<string, unknown>;
	const keys = ['path', 'file_path', 'pattern', 'query', 'command', 'dir', 'url', 'message', 'name'];
	for (const k of keys) {
		const v = record[k];
		if (typeof v === 'string' && v) return v;
	}
	return '';
}

/** 将任意值转为展示文本。 */
export function stringifyValue(v: unknown): string {
	if (v === null || v === undefined) return '';
	return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

/** 截断长文本。 */
export function truncateText(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}\n… (已截断)` : s;
}

/** 渲染动作（与宿主消息命令一一对应，外加本地 UI 动作）。 */
export type ChatAction =
	| { type: 'openSession'; sessionId: string; title?: string }
	| { type: 'sessionCreated'; sessionId: string }
	| { type: 'replyChunk'; text: string }
	| { type: 'replyEnd' }
	| { type: 'stepEnd' }
	| { type: 'thought'; text: string }
	| { type: 'plan'; steps: string[] }
	| { type: 'toolCall'; callId: string; tool: string; args?: unknown }
	| { type: 'toolState'; callId: string; tool: string; state: ToolState; error?: string; args?: unknown; output?: unknown }
	| { type: 'toolResult'; callId: string; status: string; result?: unknown; error?: string }
	| { type: 'diffResult'; callId: string; filePath: string; diffHtml: string; additions: number; deletions: number }
	| { type: 'approvalRequest'; callId: string; toolName: string; summary: string; filePath?: string }
	| { type: 'approvalResolved'; callId: string }
	| { type: 'error'; message: string }
	| { type: 'progress'; phase?: string }
	| { type: 'tokenUsage'; payload: { token_usage?: TokenUsageDetail } }
	| { type: 'sessionTokenUsage'; payload: SessionTokenPayload }
	| { type: 'historyLoaded'; messages: HistoryEntry[] }
	| { type: 'workspaceFiles'; files: WorkspaceFile[] }
	| { type: 'modelInfo'; model: string }
	| { type: 'slashCommands'; groups: SlashCommandGroup[] }
	| { type: 'sessionList'; sessions: SessionMeta[] }
	| { type: 'currentSessionDeleted' }
	| { type: 'setSelectedFiles'; files: WorkspaceFile[] }
	| { type: 'setSelectedSkills'; skills: SlashCommand[] }
	| { type: 'userMessageSent'; text: string }
	| { type: 'deleteUserMessage'; messageId: string }
	| { type: 'deleteAssistantMessage'; messageId: string }
	| { type: 'toggleToolExpand'; callId: string }
	| { type: 'toggleDiffExpand'; callId: string }
	| { type: 'clearError' };

/** 清空当前会话的对话内容（新建/切换/删除会话后调用），保留会话指针。 */
function resetConversation(state: ChatState): ChatState {
	return {
		...state,
		messages: [],
		toolEntries: {},
		approvals: {},
		diffs: {},
		turnCounter: 0,
		liveAssistantId: null,
		liveThoughtId: null,
		isStreaming: false,
		sessionTokenUsage: null,
	};
}

/** 取当前回合号：用户消息已发则用最新回合，否则回退 0（历史/初始步骤容器）。 */
function currentTurn(state: ChatState): number {
	return state.turnCounter;
}

/**
 * 按历史消息聚合会话 token 累计（与实时服务端汇总一致）：
 * 仅以 assistant tokenUsage 快照为权威，user inputTokens 不双重累计；
 * 无快照旧消息按内容估算补齐（仅展示）。
 */
export function aggregateSessionTokens(messages: readonly HistoryEntry[]): SessionTokenPayload | null {
	if (!messages || messages.length === 0) return null;
	let total = 0;
	const breakdown = { reasoning: 0, tool_calls: 0, model_output: 0, user_input: 0, context: 0 };
	let noCache = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	for (const m of messages) {
		if (m.role !== 'assistant') continue;
		const tu = m.tokenUsage;
		if (tu) {
			total += tu.total_tokens || 0;
			breakdown.reasoning += tu.reasoning || 0;
			breakdown.tool_calls += tu.tool_calls || 0;
			breakdown.model_output += tu.model_output || 0;
			breakdown.user_input += tu.user_input || 0;
			breakdown.context += tu.context || 0;
			noCache += tu.no_cache_tokens || 0;
			cacheRead += tu.cache_read_tokens || 0;
			cacheWrite += tu.cache_write_tokens || 0;
		} else {
			// 旧消息无 token 账：按内容估算（不回写）
			const text = (m.content || '') + (m.toolCalls || []).map((tc) => `${tc.name}${tc.arguments}`).join('');
			const est = Math.ceil(text.length / 4);
			breakdown.model_output += est;
			total += est;
		}
	}
	if (total <= 0 && breakdown.user_input <= 0 && breakdown.model_output <= 0) return null;
	const result: SessionTokenPayload = {
		total_tokens: total || breakdown.user_input + breakdown.model_output,
		breakdown,
		...(noCache > 0 ? { no_cache_tokens: noCache } : {}),
		...(cacheRead > 0 ? { cache_read_tokens: cacheRead } : {}),
		...(cacheWrite > 0 ? { cache_write_tokens: cacheWrite } : {}),
	};
	return result;
}

/** 工具状态转换辅助：同 call_id 复用条目，不产生重复。 */
function upsertToolEntry(
	state: ChatState,
	callId: string,
	tool: string,
	target: { state?: ToolState; error?: string; args?: unknown; output?: unknown }
): ChatState {
	const existing = state.toolEntries[callId];
	const merged: ToolEntry = existing
		? {
				call_id: callId,
				tool: existing.tool || tool,
				state: target.state ?? existing.state,
				args: target.args !== undefined && target.args !== null ? target.args : existing.args,
				output: target.output !== undefined && target.output !== null ? target.output : existing.output,
				error: target.error || existing.error,
				expanded: existing.expanded,
		  }
		: {
				call_id: callId,
				tool,
				state: target.state ?? 'pending',
				args: target.args,
				output: target.output,
				error: target.error,
				expanded: false,
		  };
	return { ...state, toolEntries: { ...state.toolEntries, [callId]: merged } };
}

/** 工具时间线步骤：消息流中不存在该 call_id 的 step 时向当前回合追加。 */
function ensureToolStep(state: ChatState, callId: string): ChatState {
	if (state.messages.some((m) => m.kind === 'tool' && m.callId === callId)) return state;
	const turn = currentTurn(state);
	const messages = [...state.messages, { id: nextId('tool'), kind: 'tool' as const, callId, turn }];
	return { ...state, messages };
}

/**
 * 全局状态 reducer（纯函数）。
 *
 * @param state 当前状态
 * @param action 待处理动作
 * @returns 新状态
 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
	switch (action.type) {
		case 'openSession':
		case 'sessionCreated': {
			return {
				...resetConversation(state),
				currentSessionId: action.sessionId,
				sessionTitle: action.type === 'openSession' && action.title ? action.title : state.sessionTitle,
				error: '',
			};
		}
		case 'replyChunk': {
			let messages = state.messages;
			let liveAssistantId = state.liveAssistantId;
			if (!liveAssistantId) {
				const turn = currentTurn(state);
				liveAssistantId = nextId('assistant');
				messages = [...messages, { id: liveAssistantId, kind: 'assistant', text: '', streaming: true, turn }];
			}
			messages = messages.map((m) =>
				m.id === liveAssistantId && m.kind === 'assistant'
					? { ...m, text: m.text + action.text, streaming: true }
					: m
			);
			return { ...state, messages, liveAssistantId };
		}
		case 'stepEnd':
		case 'replyEnd': {
			const messages = state.messages.map((m) =>
				m.id === state.liveAssistantId && m.kind === 'assistant' ? { ...m, streaming: false } : m
			);
			return {
				...state,
				messages,
				liveAssistantId: null,
				liveThoughtId: null,
				isStreaming: action.type === 'replyEnd' ? false : state.isStreaming,
			};
		}
		case 'thought': {
			const turn = currentTurn(state);
			let liveThoughtId = state.liveThoughtId;
			let messages = state.messages;
			if (!liveThoughtId) {
				liveThoughtId = nextId('thought');
				messages = [...messages, { id: liveThoughtId, kind: 'thought', text: '', turn }];
			}
			messages = messages.map((m) =>
				m.id === liveThoughtId && m.kind === 'thought'
					? { ...m, text: mergeStreamText(m.text, action.text) }
					: m
			);
			return { ...state, messages, liveThoughtId };
		}
		case 'plan': {
			const turn = currentTurn(state);
			const messages = [...state.messages, { id: nextId('plan'), kind: 'plan' as const, steps: action.steps, turn }];
			return { ...state, messages };
		}
		case 'toolCall': {
			const withEntry = upsertToolEntry(state, action.callId, action.tool, { state: 'pending', args: action.args });
			return ensureToolStep(withEntry, action.callId);
		}
		case 'toolState': {
			const withEntry = upsertToolEntry(state, action.callId, action.tool, {
				state: action.state,
				error: action.error,
				args: action.args,
				output: action.output,
			});
			return ensureToolStep(withEntry, action.callId);
		}
		case 'toolResult': {
			// 仅补充数据，不单独渲染（tool_state_change 已覆盖）；未创建条目时补建 success 步骤
			const withEntry = upsertToolEntry(state, action.callId, 'tool', { state: 'success', output: action.result, error: action.error });
			return ensureToolStep(withEntry, action.callId);
		}
		case 'diffResult': {
			const diff: DiffEntry = {
				call_id: action.callId,
				file_path: action.filePath,
				diff_html: action.diffHtml,
				additions: action.additions,
				deletions: action.deletions,
				expanded: false,
			};
			const messages = state.messages.some((m) => m.kind === 'diff' && m.callId === action.callId)
				? state.messages
				: [...state.messages, { id: nextId('diff'), kind: 'diff' as const, callId: action.callId, turn: currentTurn(state) }];
			return { ...state, diffs: { ...state.diffs, [action.callId]: diff }, messages };
		}
		case 'approvalRequest': {
			const approval: ApprovalEntry = {
				call_id: action.callId,
				tool_name: action.toolName,
				summary: action.summary,
				file_path: action.filePath,
				resolved: false,
			};
			const messages = state.messages.some((m) => m.kind === 'approval' && m.callId === action.callId)
				? state.messages
				: [...state.messages, { id: nextId('approval'), kind: 'approval' as const, callId: action.callId, turn: currentTurn(state) }];
			return { ...state, approvals: { ...state.approvals, [action.callId]: approval }, messages };
		}
		case 'approvalResolved': {
			const approvals = { ...state.approvals };
			if (approvals[action.callId]) {
				approvals[action.callId] = { ...approvals[action.callId], resolved: true };
			}
			return { ...state, approvals };
		}
		case 'error': {
			// 停止流式并收尾当前文本步（与迁移前 finalizeStepText + finishTurn 行为一致）
			const messages = state.messages.map((m) =>
				m.id === state.liveAssistantId && m.kind === 'assistant' ? { ...m, streaming: false } : m
			);
			return {
				...state,
				messages,
				error: action.message,
				isStreaming: false,
				liveAssistantId: null,
				liveThoughtId: null,
			};
		}
		case 'progress': {
			const messages = state.messages.map((m) =>
				m.kind === 'compaction' ? { ...m, active: action.phase === 'compacting' } : m
			);
			const hasCompaction = state.messages.some((m) => m.kind === 'compaction');
			const nextMessages = hasCompaction
				? messages
				: [...state.messages, { id: nextId('compaction'), kind: 'compaction' as const, active: action.phase === 'compacting', turn: currentTurn(state) }];
			return { ...state, messages: nextMessages };
		}
		case 'tokenUsage': {
			if (!action.payload?.token_usage || !state.liveAssistantId) return state;
			const messages = state.messages.map((m) =>
				m.id === state.liveAssistantId && m.kind === 'assistant'
					? { ...m, tokenUsage: action.payload.token_usage }
					: m
			);
			return { ...state, messages };
		}
		case 'sessionTokenUsage': {
			return { ...state, sessionTokenUsage: action.payload };
		}
		case 'historyLoaded': {
			const base = resetConversation(state);
			let messages: MessageItem[] = [];
			let turnCounter = 0;
			const toolEntries: Record<string, ToolEntry> = {};
			for (const m of action.messages) {
				if (m.role === 'tool' && m.toolCallId) {
					// 工具结果消息：更新已有 pending 条目，或创建已完成步骤
					const existing = toolEntries[m.toolCallId];
					if (existing) {
						toolEntries[m.toolCallId] = {
							...existing,
							state: 'success',
							output: m.content,
						};
					} else {
						turnCounter += 1;
						const callId = m.toolCallId;
						toolEntries[callId] = {
							call_id: callId,
							tool: 'tool',
							state: 'success',
							output: m.content,
							expanded: false,
						};
						messages = [...messages, { id: nextId('tool'), kind: 'tool', callId, turn: turnCounter }];
					}
				} else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
					// 含工具调用的 assistant 消息：先渲染回复文本，再渲染工具步骤（与实时交错顺序一致）
					turnCounter += 1;
					if (m.content) {
						messages = [...messages, { id: nextId('assistant'), kind: 'assistant', text: m.content, streaming: false, tokenUsage: m.tokenUsage, turn: turnCounter }];
					}
					for (const tc of m.toolCalls) {
						let parsedArgs: unknown;
						try {
							parsedArgs = JSON.parse(tc.arguments);
						} catch {
							parsedArgs = {};
						}
						toolEntries[tc.id] = {
							call_id: tc.id,
							tool: tc.name,
							state: 'success',
							args: parsedArgs,
							expanded: false,
						};
						messages = [...messages, { id: nextId('tool'), kind: 'tool', callId: tc.id, turn: turnCounter }];
					}
				} else if (m.role === 'assistant') {
					turnCounter += 1;
					messages = [...messages, { id: nextId('assistant'), kind: 'assistant', text: m.content, streaming: false, tokenUsage: m.tokenUsage, turn: turnCounter }];
				} else if (m.role === 'user') {
					turnCounter += 1;
					messages = [...messages, { id: nextId('user'), kind: 'user', text: m.content, turn: turnCounter }];
				}
			}
			const sessionTokenUsage = aggregateSessionTokens(action.messages);
			return {
				...base,
				messages,
				turnCounter,
				toolEntries,
				sessionTokenUsage,
			};
		}
		case 'workspaceFiles':
			return { ...state, workspaceFiles: action.files };
		case 'modelInfo':
			return { ...state, modelName: action.model };
		case 'slashCommands':
			return { ...state, slashCommandGroups: action.groups };
		case 'sessionList':
			return { ...state, sessions: action.sessions };
		case 'currentSessionDeleted':
			return {
				...resetConversation(state),
				currentSessionId: null,
				sessionTitle: '',
				error: '',
			};
		case 'setSelectedFiles':
			return { ...state, selectedFiles: action.files };
		case 'setSelectedSkills':
			return { ...state, selectedSkills: action.skills };
		case 'userMessageSent': {
			// 用户消息由前端渲染（宿主不回传）：开启新回合并追加消息
			const turn = state.turnCounter + 1;
			const messages = [...state.messages, { id: nextId('user'), kind: 'user' as const, text: action.text, turn }];
			return { ...state, messages, turnCounter: turn, selectedFiles: [], selectedSkills: [] };
		}
		case 'deleteUserMessage': {
			// 删除用户消息及其后续同回合内容（与迁移前"删除此消息"行为一致）
			const idx = state.messages.findIndex((m) => m.id === action.messageId && m.kind === 'user');
			if (idx < 0) return state;
			const turn = state.messages[idx].turn;
			const messages = state.messages.filter((m) => !(m.id === action.messageId || (m.kind !== 'user' && m.turn === turn)));
			return { ...state, messages, liveAssistantId: null, liveThoughtId: null };
		}
		case 'deleteAssistantMessage': {
			// 删除助手消息所在回合的全部内容（步骤 + 回复）
			const msg = state.messages.find((m) => m.id === action.messageId);
			if (!msg || msg.kind !== 'assistant') return state;
			const turn = msg.turn;
			const messages = state.messages.filter((m) => !(m.kind !== 'user' && m.turn === turn));
			return { ...state, messages, liveAssistantId: null, liveThoughtId: null };
		}
		case 'toggleToolExpand': {
			const entry = state.toolEntries[action.callId];
			if (!entry) return state;
			const toolEntries = { ...state.toolEntries, [action.callId]: { ...entry, expanded: !entry.expanded } };
			return { ...state, toolEntries };
		}
		case 'toggleDiffExpand': {
			const diff = state.diffs[action.callId];
			if (!diff) return state;
			const diffs = { ...state.diffs, [action.callId]: { ...diff, expanded: !diff.expanded } };
			return { ...state, diffs };
		}
		case 'clearError':
			return { ...state, error: '' };
		default:
			return state;
	}
}
