/**
 * Webview 消息协议类型定义。
 *
 * 职责：定义 Host-to-Webview 与 Webview-to-Host 的判别联合消息类型，
 * 以及共享界面状态（斜杠命令、工作区文件、会话元数据、工具/审批/Diff 条目）。
 * 消息命令名与字段与扩展宿主 `src/chatPanel.ts` 的 `postMessage` / `_handleMessage`
 * 完全兼容；仅新增 `webviewReady` 握手消息。
 */

// ── 共享界面状态类型 ──

/** 单个斜杠命令（与 src/chat/slashCommands.ts 的 SlashCommand 结构一致）。 */
export interface SlashCommand {
	/** 唯一标识（如 basic.new-session / skill.<name>） */
	readonly id: string;
	/** 命令词（不含 /），用于过滤与回填，如 new、plan */
	readonly command: string;
	/** 展示名 */
	readonly label: string;
	/** 副标题说明 */
	readonly description?: string;
	/** true=选中即发送；false=回填输入框由用户编辑后发送 */
	readonly send: boolean;
	/** 可选特殊动作：直接触发扩展侧命令而非发消息 */
	readonly action?: 'newSession' | 'stopStream';
}

/** 斜杠命令分组。 */
export interface SlashCommandGroup {
	/** 分组标识 */
	readonly id: 'basic' | 'agents' | 'skills';
	/** 分组展示名 */
	readonly label: string;
	/** 组内命令 */
	readonly commands: readonly SlashCommand[];
}

/** 工作区文件（@ 引用选择器选项）。 */
export interface WorkspaceFile {
	/** 相对工作区根的展示路径（多工作区带 folderName/ 前缀） */
	readonly path: string;
	/** 文件基名 */
	readonly name: string;
}

/** 会话元数据（历史下拉展示）。 */
export interface SessionMeta {
	/** 会话 ID（UUID） */
	readonly sessionId: string;
	/** 展示标题：首条用户消息截断或自定义名 */
	readonly title: string;
	/** 创建时间（ISO 字符串） */
	readonly createdAt: string;
	/** 最近活动时间（ISO 字符串） */
	readonly updatedAt: string;
	/** 消息条数 */
	readonly messageCount: number;
	/** 标题是否为用户自定义 */
	readonly customTitle: boolean;
}

/** 历史消息条目（与 LocalSessionManager.HistoryEntry 结构一致）。 */
export interface HistoryEntry {
	/** 消息角色：user / assistant / tool */
	readonly role: string;
	/** 消息文本内容 */
	readonly content: string;
	/** assistant 消息携带的工具调用列表 */
	readonly toolCalls?: readonly { id: string; name: string; arguments: string }[];
	/** tool 消息关联的工具调用 ID */
	readonly toolCallId?: string;
	/** assistant 消息的 token 账快照（真实 usage + 四类拆分） */
	readonly tokenUsage?: {
		readonly prompt_tokens: number;
		readonly completion_tokens: number;
		readonly total_tokens: number;
		readonly reasoning_tokens?: number;
		readonly cache_read_tokens?: number;
		readonly cache_write_tokens?: number;
		readonly no_cache_tokens?: number;
		readonly reasoning: number;
		readonly tool_calls: number;
		readonly model_output: number;
		readonly user_input: number;
		readonly context: number;
		readonly source: string;
	};
	/** user 消息的输入 token 分摊值（估算） */
	readonly inputTokens?: number;
}

/** 单次 LLM 调用的 token 用量明细（tokenUsage 事件 payload.token_usage）。 */
export interface TokenUsageDetail {
	readonly prompt_tokens?: number;
	readonly completion_tokens?: number;
	readonly total_tokens?: number;
	readonly reasoning_tokens?: number;
	readonly no_cache_tokens?: number;
	readonly cache_read_tokens?: number;
	readonly cache_write_tokens?: number;
}

/** 会话级 token 累计 payload（sessionTokenUsage 事件）。 */
export interface SessionTokenPayload {
	readonly total_tokens?: number;
	readonly breakdown?: {
		readonly reasoning?: number;
		readonly tool_calls?: number;
		readonly model_output?: number;
		readonly user_input?: number;
		readonly context?: number;
	};
	readonly no_cache_tokens?: number;
	readonly cache_read_tokens?: number;
	readonly cache_write_tokens?: number;
}

/** 工具调用状态（时间线转换：pending → running → success/error）。 */
export type ToolState = 'pending' | 'running' | 'success' | 'error';

/** 审批决定。 */
export type ApprovalDecision = 'allow' | 'always' | 'deny';

/** 工具时间线条目（按 call_id 维护单一实例）。 */
export interface ToolEntry {
	readonly call_id: string;
	readonly tool: string;
	readonly state: ToolState;
	readonly args?: unknown;
	readonly output?: unknown;
	readonly error?: string;
	/** 详情是否展开 */
	readonly expanded: boolean;
}

/** 审批卡片条目（决定作出后移除）。 */
export interface ApprovalEntry {
	readonly call_id: string;
	readonly tool_name: string;
	readonly summary: string;
	readonly file_path?: string;
	/** 是否已作出决定（退场中） */
	readonly resolved: boolean;
}

/** Diff 卡片条目。 */
export interface DiffEntry {
	readonly call_id: string;
	readonly file_path: string;
	readonly diff_html: string;
	readonly additions: number;
	readonly deletions: number;
	readonly expanded: boolean;
}

// ── Host → Webview 消息 ──

/** 宿主推送模型名（webviewReady 握手后发送）。 */
export interface ModelInfoMessage {
	readonly command: 'modelInfo';
	readonly model: string;
}

/** 宿主推送斜杠命令分组。 */
export interface SlashCommandsMessage {
	readonly command: 'slashCommands';
	readonly groups: SlashCommandGroup[];
}

/** 宿主通知切换/创建会话（创建时不带 title）。 */
export interface OpenSessionMessage {
	readonly command: 'openSession';
	readonly sessionId: string;
	readonly title?: string;
}

/** 宿主确认会话创建成功。 */
export interface SessionCreatedMessage {
	readonly command: 'sessionCreated';
	readonly sessionId: string;
}

/** 流式文本增量。 */
export interface ReplyChunkMessage {
	readonly command: 'replyChunk';
	readonly text: string;
}

/** 一步结束（终渲染当前步 markdown）。 */
export interface StepEndMessage {
	readonly command: 'stepEnd';
}

/** 单次调用 token 用量。 */
export interface TokenUsageMessage {
	readonly command: 'tokenUsage';
	readonly payload: { token_usage?: TokenUsageDetail };
}

/** 会话累计 token。 */
export interface SessionTokenUsageMessage {
	readonly command: 'sessionTokenUsage';
	readonly payload: SessionTokenPayload;
}

/** 流式回复结束。 */
export interface ReplyEndMessage {
	readonly command: 'replyEnd';
}

/** 错误提示。 */
export interface ErrorMessage {
	readonly command: 'error';
	readonly message: string;
}

/** 工具状态推进（同一 call_id 复用时间线条目）。 */
export interface ToolStateMessage {
	readonly command: 'toolState';
	readonly call_id: string;
	readonly tool: string;
	readonly state: ToolState;
	readonly error?: string;
	readonly args?: unknown;
	readonly output?: unknown;
}

/** Diff 结果（code_edit 成功且含 diff 数据时额外发送）。 */
export interface DiffResultMessage {
	readonly command: 'diffResult';
	readonly call_id: string;
	readonly file_path: string;
	readonly diff_html: string;
	readonly additions: number;
	readonly deletions: number;
}

/** 工具调用开始（pending）。 */
export interface ToolCallMessage {
	readonly command: 'toolCall';
	readonly call_id: string;
	readonly tool: string;
	readonly args?: unknown;
}

/** 工具结果（仅补充数据，不单独渲染，toolState 已覆盖）。 */
export interface ToolResultMessage {
	readonly command: 'toolResult';
	readonly call_id: string;
	readonly status: string;
	readonly result?: unknown;
	readonly error?: string;
}

/** 思考文本增量。 */
export interface ThoughtMessage {
	readonly command: 'thought';
	readonly text: string;
}

/** 进度通知（如上下文压缩）。 */
export interface ProgressMessage {
	readonly command: 'progress';
	readonly phase?: string;
}

/** 计划步骤。 */
export interface PlanMessage {
	readonly command: 'plan';
	readonly steps: string[];
}

/** 历史消息加载完成。 */
export interface HistoryLoadedMessage {
	readonly command: 'historyLoaded';
	readonly messages: HistoryEntry[];
}

/** 扩展侧触发新建会话（工具栏按钮）。 */
export interface TriggerNewSessionMessage {
	readonly command: 'triggerNewSession';
}

/** 审批请求。 */
export interface ApprovalRequestMessage {
	readonly command: 'approvalRequest';
	readonly call_id: string;
	readonly tool_name: string;
	readonly summary: string;
	readonly file_path?: string;
}

/** 工作区文件列表（@ 引用）。 */
export interface WorkspaceFilesMessage {
	readonly command: 'workspaceFiles';
	readonly files: WorkspaceFile[];
}

/** 会话列表（历史下拉）。 */
export interface SessionListMessage {
	readonly command: 'sessionList';
	readonly sessions: SessionMeta[];
}

/** 宿主显式通知当前会话已被删除。 */
export interface CurrentSessionDeletedMessage {
	readonly command: 'currentSessionDeleted';
}

/** Host → Webview 判别联合。 */
export type HostToWebviewMessage =
	| ModelInfoMessage
	| SlashCommandsMessage
	| OpenSessionMessage
	| SessionCreatedMessage
	| ReplyChunkMessage
	| StepEndMessage
	| TokenUsageMessage
	| SessionTokenUsageMessage
	| ReplyEndMessage
	| ErrorMessage
	| ToolStateMessage
	| DiffResultMessage
	| ToolCallMessage
	| ToolResultMessage
	| ThoughtMessage
	| ProgressMessage
	| PlanMessage
	| HistoryLoadedMessage
	| TriggerNewSessionMessage
	| ApprovalRequestMessage
	| WorkspaceFilesMessage
	| SessionListMessage
	| CurrentSessionDeletedMessage;

// ── Webview → Host 消息 ──

/** 应用挂载完成握手：宿主随后推送模型名与斜杠命令初始数据。 */
export interface WebviewReadyMessage {
	readonly command: 'webviewReady';
}

/** 新建会话。 */
export interface CreateSessionMessage {
	readonly command: 'createSession';
}

/** 发送用户消息（文件引用与 Skill 作为独立字段）。 */
export interface SendMessageMessage {
	readonly command: 'sendMessage';
	readonly sessionId: string;
	readonly text: string;
	readonly files: WorkspaceFile[];
	readonly skills: string[];
}

/** 停止当前流式回复。 */
export interface StopStreamMessage {
	readonly command: 'stopStream';
	readonly sessionId: string;
}

/** 加载会话历史。 */
export interface LoadHistoryMessage {
	readonly command: 'loadHistory';
	readonly sessionId: string;
}

/** 审批决定回传。 */
export interface ApprovalDecisionMessage {
	readonly command: 'approvalDecision';
	readonly call_id: string;
	readonly decision: ApprovalDecision;
}

/** 在差异编辑器中打开文件。 */
export interface OpenDiffMessage {
	readonly command: 'openDiff';
	readonly file_path: string;
}

/** 打开文件选择对话框。 */
export interface OpenFileMessage {
	readonly command: 'openFile';
}

/** 拉取斜杠命令分组（webview 重建后数据丢失时主动请求）。 */
export interface RequestSlashCommandsMessage {
	readonly command: 'requestSlashCommands';
}

/** 拉取工作区文件列表。 */
export interface RequestWorkspaceFilesMessage {
	readonly command: 'requestWorkspaceFiles';
}

/** 重命名会话。 */
export interface RenameSessionMessage {
	readonly command: 'renameSession';
	readonly sessionId: string;
	readonly name: string;
}

/** 请求会话列表（打开历史下拉时）。 */
export interface RequestSessionsMessage {
	readonly command: 'requestSessions';
}

/** 打开历史会话（host 切换指针并回推 openSession）。 */
export interface OpenSessionRequestMessage {
	readonly command: 'openSession';
	readonly sessionId: string;
}

/** 删除会话（host 弹确认框）。 */
export interface DeleteSessionMessage {
	readonly command: 'deleteSession';
	readonly sessionId: string;
}

/** 请求在编辑器中打开独立设置标签。 */
export interface OpenSettingsMessage {
	readonly command: 'openSettings';
}

/** Webview → Host 判别联合。 */
export type WebviewToHostMessage =
	| WebviewReadyMessage
	| CreateSessionMessage
	| SendMessageMessage
	| StopStreamMessage
	| LoadHistoryMessage
	| ApprovalDecisionMessage
	| OpenDiffMessage
	| OpenFileMessage
	| RequestSlashCommandsMessage
	| RequestWorkspaceFilesMessage
	| RenameSessionMessage
	| RequestSessionsMessage
	| OpenSessionRequestMessage
	| DeleteSessionMessage
	| OpenSettingsMessage;

/** 任一方向消息的命令名（用于日志与调试）。 */
export type MessageCommand = HostToWebviewMessage['command'] | WebviewToHostMessage['command'];
