/**
 * Webview 协议映射与 reducer 单元测试。
 *
 * 覆盖：宿主消息 → reducer 动作映射（协议兼容）、`webviewReady` 握手相关初始数据、
 * 关键 reducer 状态转换（流式追加、工具时间线复用、审批/Diff、历史恢复与 token 聚合）。
 */
import { describe, it, expect } from 'vitest';
import { hostToAction } from '../state/hostActions';
import { chatReducer, initialState, aggregateSessionTokens, summarizeArgs, type ChatState } from '../state/reducer';
import type { HostToWebviewMessage } from '../protocol';

describe('todoState', () => {
	it('映射并清除空任务快照', () => {
		const action = hostToAction({
			command: 'todoState',
			snapshot: { todos: [{ id: 'one', content: '实现任务面板', status: 'in_progress' }] },
			summary: { total: 1, pending: 0, in_progress: 1, completed: 0, cancelled: 0 },
		});
		expect(action).toEqual({
			type: 'todoState',
			snapshot: { todos: [{ id: 'one', content: '实现任务面板', status: 'in_progress' }] },
			summary: { total: 1, pending: 0, in_progress: 1, completed: 0, cancelled: 0 },
		});
		const populated = chatReducer(initialState, action!);
		expect(populated.todoSnapshot?.todos[0].status).toBe('in_progress');
		const cleared = chatReducer(populated, {
			type: 'todoState',
			snapshot: { todos: [] },
			summary: { total: 0, pending: 0, in_progress: 0, completed: 0, cancelled: 0 },
		});
		expect(cleared.todoSnapshot).toBeNull();
	});
});

/** 构造一个已进入会话且完成握手的初始状态。 */
function activeState(overrides: Partial<ChatState> = {}): ChatState {
	return {
		...initialState,
		currentSessionId: 'session-1',
		...overrides,
	};
}

describe('协议映射 hostToAction', () => {
	it('运行时状态映射并更新加载状态', () => {
		const action = hostToAction({ command: 'runtimeState', status: 'failed', message: 'Skill 加载失败' });
		expect(action).toEqual({ type: 'runtimeState', status: 'failed', message: 'Skill 加载失败' });
		expect(chatReducer(initialState, action!)).toMatchObject({
			runtimeStatus: 'failed',
			runtimeMessage: 'Skill 加载失败',
		});
	});

	it('webviewReady 握手后宿主推送 modelInfo 与 slashCommands 映射为对应动作', () => {
		// 握手消息本身由 App 层发送（webview → host），此处验证宿主回推的初始数据映射
		expect(hostToAction({ command: 'modelInfo', model: 'gpt-4o' })).toEqual({ type: 'modelInfo', model: 'gpt-4o' });
		expect(
			hostToAction({ command: 'slashCommands', groups: [{ id: 'basic', label: '基础功能', commands: [] }] })
		).toEqual({
			type: 'slashCommands',
			groups: [{ id: 'basic', label: '基础功能', commands: [] }],
		});
	});

	it('openSession 携带标题，sessionCreated 不带标题', () => {
		expect(hostToAction({ command: 'openSession', sessionId: 's1', title: '旧会话' })).toEqual({
			type: 'openSession',
			sessionId: 's1',
			title: '旧会话',
		});
		expect(hostToAction({ command: 'sessionCreated', sessionId: 's2' })).toEqual({
			type: 'sessionCreated',
			sessionId: 's2',
		});
	});

	it('流式与工具消息保留宿主字段名（call_id / tool / state）', () => {
		expect(hostToAction({ command: 'replyChunk', text: '你' })).toEqual({ type: 'replyChunk', text: '你' });
		expect(
			hostToAction({ command: 'toolCall', call_id: 'c1', tool: 'fs_read_file', args: { path: 'a.ts' } })
		).toEqual({ type: 'toolCall', callId: 'c1', tool: 'fs_read_file', args: { path: 'a.ts' } });
		expect(
			hostToAction({ command: 'toolState', call_id: 'c1', tool: 'fs_read_file', state: 'success', output: 'ok' })
		).toEqual({ type: 'toolState', callId: 'c1', tool: 'fs_read_file', state: 'success', output: 'ok' });
	});

	it('审批与 Diff 消息保留 file_path / call_id 语义', () => {
		expect(
			hostToAction({ command: 'approvalRequest', call_id: 'c2', tool_name: 'fs_write_file', summary: '写入 a.ts', file_path: 'a.ts' })
		).toEqual({
			type: 'approvalRequest',
			callId: 'c2',
			toolName: 'fs_write_file',
			summary: '写入 a.ts',
			filePath: 'a.ts',
		});
		expect(
			hostToAction({ command: 'diffResult', call_id: 'c2', file_path: 'a.ts', diff_html: '<table></table>', additions: 1, deletions: 2 })
		).toEqual({
			type: 'diffResult',
			callId: 'c2',
			filePath: 'a.ts',
			diffHtml: '<table></table>',
			additions: 1,
			deletions: 2,
		});
	});

	it('triggerNewSession 需要副作用，映射为 null', () => {
		expect(hostToAction({ command: 'triggerNewSession' })).toBeNull();
	});
});

describe('reducer 状态转换', () => {
	it('openSession 重置对话并设置会话与标题', () => {
		const before = activeState({ messages: [{ id: 'u1', kind: 'user', text: 'x', turn: 1 }], isStreaming: true });
		const next = chatReducer(before, { type: 'openSession', sessionId: 's-new', title: '新标题' });
		expect(next.currentSessionId).toBe('s-new');
		expect(next.sessionTitle).toBe('新标题');
		expect(next.messages).toEqual([]);
		expect(next.isStreaming).toBe(false);
	});

	it('sessionCreated 新建会话时清空标题，不复用上一个会话的名称', () => {
		const before = activeState({ currentSessionId: 'session-1', sessionTitle: '上一个会话名称' });
		const next = chatReducer(before, { type: 'sessionCreated', sessionId: 'session-2' });
		expect(next.currentSessionId).toBe('session-2');
		expect(next.sessionTitle).toBe('');
	});

	it('replyChunk 创建流式 assistant 并追加文本，replyEnd 收尾', () => {
		let state = activeState();
		state = chatReducer(state, { type: 'replyChunk', text: '你' });
		state = chatReducer(state, { type: 'replyChunk', text: '好' });
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({ kind: 'assistant', text: '你好', streaming: true });
		const liveId = state.liveAssistantId;
		state = chatReducer(state, { type: 'replyEnd' });
		expect(state.isStreaming).toBe(false);
		expect(state.liveAssistantId).toBeNull();
		expect(state.messages.find((m) => m.id === liveId)).toMatchObject({ streaming: false });
	});

	it('stepEnd 只收尾文本步，不结束整体流式状态', () => {
		let state = activeState({ isStreaming: true });
		state = chatReducer(state, { type: 'replyChunk', text: '第一段' });
		state = chatReducer(state, { type: 'stepEnd' });
		expect(state.isStreaming).toBe(true);
		expect(state.liveAssistantId).toBeNull();
	});

	it('thought 增量合并（mergeStreamText 语义：增量或累计取较全者）', () => {
		let state = activeState();
		state = chatReducer(state, { type: 'thought', text: 'The ' });
		state = chatReducer(state, { type: 'thought', text: 'user' });
		state = chatReducer(state, { type: 'thought', text: 'The user wants' });
		const thought = state.messages.find((m) => m.kind === 'thought') as { text: string } | undefined;
		expect(thought?.text).toBe('The user wants');
	});

	it('工具状态在同一 call_id 时间线条目中转换且不产生重复条目', () => {
		let state = activeState();
		state = chatReducer(state, { type: 'toolCall', callId: 'c1', tool: 'fs_read_file', args: { path: 'a.ts' } });
		state = chatReducer(state, { type: 'toolState', callId: 'c1', tool: 'fs_read_file', state: 'running' });
		state = chatReducer(state, { type: 'toolState', callId: 'c1', tool: 'fs_read_file', state: 'success', output: 'ok' });

		expect(state.toolEntries['c1']).toMatchObject({ state: 'success', output: 'ok', args: { path: 'a.ts' } });
		expect(state.messages.filter((m) => m.kind === 'tool' && m.callId === 'c1')).toHaveLength(1);
	});

	it('diffResult 添加卡片；同一 call_id 再次到达时替换内容不重复添加', () => {
		let state = activeState();
		state = chatReducer(state, { type: 'diffResult', callId: 'c2', filePath: 'a.ts', diffHtml: '<table>v1</table>', additions: 1, deletions: 2 });
		state = chatReducer(state, { type: 'diffResult', callId: 'c2', filePath: 'a.ts', diffHtml: '<table>v2</table>', additions: 3, deletions: 4 });

		expect(state.diffs['c2'].diff_html).toBe('<table>v2</table>');
		expect(state.messages.filter((m) => m.kind === 'diff' && m.callId === 'c2')).toHaveLength(1);
	});

	it('审批决定后移除卡片与消息条目，不保留不可见占位', () => {
		let state = activeState();
		state = chatReducer(state, { type: 'approvalRequest', callId: 'c3', toolName: 'fs_write_file', summary: '写入', filePath: 'b.ts' });
		expect(state.approvals['c3']).toMatchObject({ resolved: false, tool_name: 'fs_write_file' });
		state = chatReducer(state, { type: 'approvalResolved', callId: 'c3' });
		expect(state.approvals['c3']).toBeUndefined();
		expect(state.messages.some((message) => message.kind === 'approval' && message.callId === 'c3')).toBe(false);
	});

	it('historyLoaded 重建消息并恢复工具步骤与 token 聚合', () => {
		const state = chatReducer(activeState(), {
			type: 'historyLoaded',
			messages: [
				{ role: 'user', content: 'hello' },
				{ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'fs_read_file', arguments: '{"path":"a.ts"}' }] },
				{ role: 'tool', toolCallId: 't1', content: 'file content' },
				{ role: 'assistant', content: '回复', tokenUsage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, reasoning: 20, tool_calls: 0, model_output: 30, user_input: 10, context: 90, source: 'usage' } },
			],
		});

		expect(state.messages.filter((m) => m.kind === 'user')).toHaveLength(1);
		expect(state.toolEntries['t1']).toMatchObject({ state: 'success', tool: 'fs_read_file', output: 'file content', args: { path: 'a.ts' } });
		// 带 toolCalls 的空 content assistant 消息无 token 账，按内容估算计入（与迁移前行为一致）
		expect(state.sessionTokenUsage?.total_tokens).toBe(157);
	});

	it('currentSessionDeleted 重置指针并清空对话', () => {
		const before = activeState({ messages: [{ id: 'u1', kind: 'user', text: 'x', turn: 1 }] });
		const next = chatReducer(before, { type: 'currentSessionDeleted' });
		expect(next.currentSessionId).toBeNull();
		expect(next.messages).toEqual([]);
		expect(next.isStreaming).toBe(false);
	});

	it('error 停止流式、收尾当前文本步并清空 live 引用', () => {
		let state = activeState({ isStreaming: true });
		state = chatReducer(state, { type: 'replyChunk', text: '部分' });
		const liveId = state.liveAssistantId;
		state = chatReducer(state, { type: 'error', message: 'boom' });
		expect(state.error).toBe('boom');
		expect(state.isStreaming).toBe(false);
		expect(state.liveAssistantId).toBeNull();
		expect(state.liveThoughtId).toBeNull();
		expect(state.messages.find((m) => m.id === liveId)).toMatchObject({ streaming: false });
	});

	it('deleteUserMessage 删除用户消息及其后续同回合内容', () => {
		let state = activeState();
		state = chatReducer(state, { type: 'userMessageSent', text: 'hello' });
		const userTurn = state.turnCounter;
		state = chatReducer(state, { type: 'thought', text: '思考' });
		state = chatReducer(state, { type: 'replyChunk', text: '回复' });
		expect(state.messages.length).toBeGreaterThan(1);
		const userMsg = state.messages.find((m) => m.kind === 'user');
		expect(userMsg).toBeDefined();
		state = chatReducer(state, { type: 'deleteUserMessage', messageId: userMsg!.id });
		expect(state.messages).toHaveLength(0);
		expect(userTurn).toBeGreaterThan(0);
	});

	it('deleteAssistantMessage 删除助手消息所在回合（步骤 + 回复），保留用户消息', () => {
		let state = activeState();
		state = chatReducer(state, { type: 'userMessageSent', text: 'hi' });
		state = chatReducer(state, { type: 'toolCall', callId: 't1', tool: 'fs_read_file' });
		state = chatReducer(state, { type: 'replyChunk', text: 'ok' });
		const assistant = state.messages.find((m) => m.kind === 'assistant');
		expect(assistant).toBeDefined();
		state = chatReducer(state, { type: 'deleteAssistantMessage', messageId: assistant!.id });
		expect(state.messages.filter((m) => m.kind === 'user')).toHaveLength(1);
		expect(state.messages.filter((m) => m.kind !== 'user')).toHaveLength(0);
	});
});

describe('历史 token 聚合 aggregateSessionTokens', () => {
	it('仅以 assistant tokenUsage 快照为权威，user inputTokens 不双重累计', () => {
		const agg = aggregateSessionTokens([
			{ role: 'user', content: 'hello', inputTokens: 50 },
			{ role: 'assistant', content: 'hi', tokenUsage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, reasoning: 20, tool_calls: 0, model_output: 30, user_input: 10, context: 90, source: 'usage' } },
			{ role: 'user', content: 'again', inputTokens: 40 },
			{ role: 'assistant', content: 'ok', tokenUsage: { prompt_tokens: 200, completion_tokens: 60, total_tokens: 260, reasoning: 0, tool_calls: 0, model_output: 60, user_input: 20, context: 180, source: 'usage', cache_read_tokens: 90, no_cache_tokens: 110 } },
		]);
		expect(agg).not.toBeNull();
		expect(agg?.total_tokens).toBe(410);
		expect(agg?.breakdown?.user_input).toBe(30);
		expect(agg?.breakdown?.context).toBe(270);
		expect(agg?.cache_read_tokens).toBe(90);
		expect(agg?.no_cache_tokens).toBe(110);
	});

	it('无快照旧 assistant 消息按内容估算补齐（仅展示）', () => {
		const oldText = 'old reply without usage';
		const agg = aggregateSessionTokens([
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: oldText },
			{ role: 'assistant', content: 'ok', tokenUsage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, reasoning: 20, tool_calls: 0, model_output: 30, user_input: 10, context: 90, source: 'usage' } },
		]);
		expect(agg?.total_tokens).toBe(150 + Math.ceil(oldText.length / 4));
		expect(agg?.breakdown?.model_output).toBe(30 + Math.ceil(oldText.length / 4));
	});
});

describe('工具参数摘要 summarizeArgs', () => {
	it('按字段优先级挑选最有信息量的参数预览', () => {
		expect(summarizeArgs({ path: 'src/a.ts', query: 'x' })).toBe('src/a.ts');
		expect(summarizeArgs({ command: 'npm test' })).toBe('npm test');
		expect(summarizeArgs({ nested: { a: 1 } })).toBe('');
		expect(summarizeArgs('plain')).toBe('plain');
	});
});
