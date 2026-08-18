/**
 * Webview 消息协议类型定义。
 *
 * 职责：定义 Host-to-Webview 与 Webview-to-Host 的判别联合消息类型，
 * 以及共享界面状态（斜杠命令、工作区文件、会话元数据、工具/审批/Diff 条目）。
 * 消息命令名与字段与扩展宿主 `src/chatPanel.ts` 的 `postMessage` / `_handleMessage`
 * 完全兼容；仅新增 `webviewReady` 握手消息。
 */

// ── MCP 设置协议共享类型（复用 mcp/types 的非敏感视图，单一事实来源）──

/**
 * MCP 设置页非敏感视图类型，与 Extension Host 侧 `src/mcp/types.ts` 共享。
 * 仅 type-only 导入/重导出：不把 mcp 运行时代码引入 Webview bundle，且保证两侧
 * `McpServerView`/`McpToolView`/状态枚举不发生定义漂移。Host 永不在此类视图中
 * 携带 env/header 明文。
 */
import type {
	McpServerView,
	McpToolView,
	McpServerStatus,
	McpActualTransport,
	McpServerConfigView,
	McpSettingsSnapshot,
} from '../mcp/types';
import type { SessionPlanState, PlanStage } from '../memory/planTypes';
import type { UsageGranularity, TokenUsageStatsResult } from '../memory/tokenUsageStats';

export type { SessionPlanState, PlanStage };
export type { UsageGranularity, TokenUsageStatsResult };

export type {
	McpServerView,
	McpToolView,
	McpServerStatus,
	McpActualTransport,
	McpServerConfigView,
	McpSettingsSnapshot,
};

/**
 * 秘密占位常量（编辑现有 Server 时替代 env/header 明文）。
 * 运行时从 mcp/types 重导出，保证 Webview 与 Host 使用同一占位值。
 */
export { MCP_SECRET_PLACEHOLDER } from '../mcp/types';

/** MCP JSON 保存模式：add=新增/批量导入，edit=编辑单个 Server。 */
export type McpSaveMode = 'add' | 'edit';

/** MCP 操作类别（用于“操作已接受”与错误反馈，区分异步操作来源）。 */
export type McpOperation = 'save' | 'setEnabled' | 'reconnect' | 'delete';

// ── 共享界面状态类型 ──

/** 配置来源（生态 Skill 与项目规则加载来源）。 */
export type SyncSource = 'none' | 'claude' | 'trae' | 'agent';

/** 工作区工具审批模式。 */
export type ApprovalMode = 'request' | 'full-access';

/** 设置页展示的模型配置视图（API Key 只以"是否已配置"布尔形式返回，密钥永不回传）。 */
export interface ModelSettingsView {
	/** 当前默认模型 ID；未配置时缺省。 */
	readonly defaultModelId?: string;
	/** 已保存模型列表。 */
	readonly models?: readonly ModelProfileView[];
	/** Provider ID（如 "openai"） */
	readonly provider: string;
	/** 模型名称 */
	readonly model: string;
	/** API 地址 */
	readonly baseURL: string;
	/** 温度参数 */
	readonly temperature: number;
	/** 最大输出 token 数 */
	readonly maxTokens: number;
	/** 模型最大上下文 token 数。 */
	readonly maxContextTokens?: number;
	/** 模型运行时选择（迁移期开关） */
	readonly runtime?: 'ai-sdk' | 'legacy';
	/** API Key 是否已配置（不含密钥明文） */
	readonly apiKeyConfigured: boolean;
}

/** 设置页中的单个模型（不含 API Key 明文）。 */
export interface ModelProfileView {
	/** 模型配置 ID。 */
	readonly id: string;
	/** Provider ID。 */
	readonly provider: string;
	/** 模型名称。 */
	readonly model: string;
	/** API 地址。 */
	readonly baseURL: string;
	/** 温度参数。 */
	readonly temperature: number;
	/** 最大输出 token 数。 */
	readonly maxTokens: number;
	/** 模型最大上下文 token 数。 */
	readonly maxContextTokens?: number;
	/** 模型运行时选择。 */
	readonly runtime: 'ai-sdk' | 'legacy';
	/** 是否启用。 */
	readonly enabled: boolean;
	/** 是否为默认模型。 */
	readonly isDefault: boolean;
	/** API Key 是否已配置。 */
	readonly apiKeyConfigured: boolean;
}

/** 对话输入框模型弹窗中的单个候选项。 */
export interface ModelPickerItem {
	/** 模型配置唯一 ID。 */
	readonly id: string;
	/** 模型名称。 */
	readonly model: string;
	/** Provider ID。 */
	readonly provider: string;
	/** 是否为当前默认模型。 */
	readonly isDefault: boolean;
}

/** 设置页提交的模型配置（API Key 可选：非空时覆盖 SecretStorage，空/缺省保持现状）。 */
export interface ModelSettingsInput {
	/** 待编辑模型 ID；缺省时新增模型。 */
	readonly id?: string;
	/** Provider ID（如 "openai"） */
	readonly provider: string;
	/** 模型名称（必填） */
	readonly model: string;
	/** API 地址 */
	readonly baseURL: string;
	/** 温度参数 */
	readonly temperature: number;
	/** 最大输出 token 数 */
	readonly maxTokens: number;
	/** 模型最大上下文 token 数。 */
	readonly maxContextTokens: number;
	/** 模型运行时选择 */
	readonly runtime?: 'ai-sdk' | 'legacy';
	/** 可选的新 API Key（非空才更新） */
	readonly apiKey?: string;
}

/** 设置页 Skill 快照条目。 */
export interface SkillInfo {
	/** Skill 名称（唯一标识） */
	readonly name: string;
	/** 描述何时使用此 Skill */
	readonly description: string;
	/** 来源文件路径（目录加载时填充） */
	readonly sourcePath?: string;
}

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
	readonly action?: 'newSession' | 'stopStream' | 'switchModel' | 'compactContext' | 'planMode';
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
	/** 存储层消息序号（删除/回滚时用于定位消息） */
	readonly seq: number;
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
		/** 实际调用 Provider 标识（如 "openai"）；旧归档缺失时用于归入"未知模型" */
		readonly provider_id?: string;
		/** 实际调用模型标识（如 "gpt-4o-mini"）；旧归档缺失时用于归入"未知模型" */
		readonly model_id?: string;
		/** 调用当时的非敏感模型展示名（仅用于历史显示，不含鉴权信息） */
		readonly model_label?: string;
	};
	/** user 消息的输入 token 分摊值（估算） */
	readonly inputTokens?: number;
	/** 是否为系统注入消息（step 预警等）；仅 user 消息可能为 true */
	readonly injected?: boolean;
	/** 助手最终回复关联的会话代码变更概览。 */
	readonly changeSet?: ChangeSetReference;
}

/** 回复关联的会话代码变更概览。 */
export interface ChangeSetReference {
	/** 变更集 ID。 */
	readonly id: string;
	/** 受影响文件数量。 */
	readonly fileCount: number;
	/** 累计新增行数。 */
	readonly additions: number;
	/** 累计删除行数。 */
	readonly deletions: number;
}

/** 变更页文件概览。 */
export interface ChangeReviewFile {
	/** 文件稳定标识。 */
	readonly id: string;
	/** 相对工作区根路径。 */
	readonly relativePath: string;
	/** 文件状态。 */
	readonly status: 'added' | 'modified' | 'deleted';
	/** 新增行数。 */
	readonly additions: number;
	/** 删除行数。 */
	readonly deletions: number;
}

/** 变更页摘要。 */
export interface ChangeReviewSummary extends ChangeSetReference {
	/** 文件变更列表。 */
	readonly files: readonly ChangeReviewFile[];
}

/** 变更页文件详情。 */
export interface ChangeReviewFileDetail extends ChangeReviewFile {
	/** 修改前文本。 */
	readonly before: string;
	/** 修改后文本。 */
	readonly after: string;
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
	/** 实际调用 Provider 标识（如 "openai"）；旧归档缺失时用于归入"未知模型" */
	readonly provider_id?: string;
	/** 实际调用模型标识（如 "gpt-4o-mini"）；旧归档缺失时用于归入"未知模型" */
	readonly model_id?: string;
	/** 调用当时的非敏感模型展示名（仅用于历史显示，不含鉴权信息） */
	readonly model_label?: string;
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

/** 任务状态。 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/** 单条会话任务。 */
export interface TodoItem {
	/** 任务稳定唯一标识。 */
	readonly id: string;
	/** 面向用户的任务说明。 */
	readonly content: string;
	/** 当前执行状态。 */
	readonly status: TodoStatus;
}

/** 会话完整任务快照。 */
export interface TodoSnapshot {
	/** 按执行顺序排列的任务。 */
	readonly todos: readonly TodoItem[];
}

/** 任务状态计数。 */
export interface TodoSummary {
	/** 任务总数。 */
	readonly total: number;
	/** 待办数量。 */
	readonly pending: number;
	/** 进行中数量。 */
	readonly in_progress: number;
	/** 已完成数量。 */
	readonly completed: number;
	/** 已取消数量。 */
	readonly cancelled: number;
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
// ── Host → Webview 消息 ──

/** 宿主推送模型名（webviewReady 握手后发送）。 */
export interface ModelInfoMessage {
	readonly command: 'modelInfo';
	readonly model: string;
}

/** 宿主同步当前工作区审批模式。 */
export interface ApprovalModeMessage {
	readonly command: 'approvalMode';
	readonly mode: ApprovalMode;
}

/** 宿主返回对话输入框可切换的已启用模型列表。 */
export interface ModelPickerMessage {
	readonly command: 'modelPicker';
	readonly models: readonly ModelPickerItem[];
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
/** 最终回复的会话变更集已就绪。 */
export interface ReplyChangeSetMessage {
	/** 消息命令名。 */
	readonly command: 'replyChangeSet';
	/** 变更集概览。 */
	readonly changeSet: ChangeSetReference;
}

/** 宿主回推独立变更页的摘要。 */
export interface ChangeReviewSummaryMessage {
	/** 消息命令名。 */
	readonly command: 'changeReviewSummary';
	/** 变更集概览。 */
	readonly summary?: ChangeReviewSummary;
}

/** 宿主回推独立变更页的文件详情。 */
export interface ChangeReviewFileMessage {
	/** 消息命令名。 */
	readonly command: 'changeReviewFile';
	/** 文件详情。 */
	readonly file?: ChangeReviewFileDetail;
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

/** 宿主推送的会话任务快照。 */
export interface TodoStateMessage {
	/** 消息命令名。 */
	readonly command: 'todoState';
	/** 当前完整任务快照。 */
	readonly snapshot: TodoSnapshot;
	/** 当前任务状态汇总。 */
	readonly summary: TodoSummary;
}

/** 宿主推送的会话 Plan 模式状态（初始化/切换会话/加载历史/状态实时变化时回推）。 */
export interface PlanModeStateMessage {
	/** 消息命令名。 */
	readonly command: 'planModeState';
	/** 所属会话 ID（前端据此忽略非当前会话的实时事件）。 */
	readonly sessionId: string;
	/** 会话 Plan 状态（阶段 + 草案标记）。 */
	readonly state: SessionPlanState;
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

/** 回滚成功后回推被回滚的用户输入，供前端回填输入框。 */
export interface RollbackRestoredMessage {
	readonly command: 'rollbackRestored';
	readonly text: string;
}

/** 设置页模型配置快照（响应 requestModelSettings / 保存成功推送）。 */
export interface ModelSettingsMessage {
	readonly command: 'modelSettings';
	readonly model: ModelSettingsView;
}

/** 设置页模型配置保存成功（携带保存后的最新快照）。 */
export interface ModelSettingsSavedMessage {
	readonly command: 'modelSettingsSaved';
	readonly model: ModelSettingsView;
}

/** 设置页 Skill 列表快照（响应 requestSkills / 来源切换或安装成功后推送）。 */
export interface SkillsListMessage {
	readonly command: 'skillsList';
	readonly skills: SkillInfo[];
	/** 当前配置来源（none/claude/trae/agent） */
	readonly source: SyncSource;
	/** 用户配置的 Skill 加载目录（均相对工作区根） */
	readonly directories: string[];
	/** 项目 Skill 安装目标提示（未打开工作区时缺省） */
	readonly installTarget?: string;
}

/** 设置页操作错误（校验失败 / 安装失败 / 无工作区等，消息可直接展示）。 */
export interface SettingsErrorMessage {
	readonly command: 'settingsError';
	readonly message: string;
}

/** 设置页 MCP 配置快照（响应 requestMcpSettings / 运行时状态变化主动推送）。 */
export interface McpSettingsMessage {
	readonly command: 'mcpSettings';
	/** 全部 Server 的非敏感视图（不含 env/header 明文）。 */
	readonly servers: readonly McpServerView[];
}

/** MCP 配置保存成功（携带保存后的最新快照）。 */
export interface McpSettingsSavedMessage {
	readonly command: 'mcpSettingsSaved';
	readonly servers: readonly McpServerView[];
}

/** MCP 异步操作已被 Host 接受（仅代表已入队，最终状态以后续 mcpSettings 快照为准）。 */
export interface McpOperationAcceptedMessage {
	readonly command: 'mcpOperationAccepted';
	readonly serverId: string;
	readonly operation: McpOperation;
}

/** MCP 设置操作错误（含可读消息与可选字段路径 fieldPath）。 */
export interface McpSettingsErrorMessage {
	readonly command: 'mcpSettingsError';
	readonly operation: McpOperation;
	readonly message: string;
	/** 定位到 `mcpServers.<id>.<field>` 的精确字段路径（校验失败时提供）。 */
	readonly fieldPath?: string;
}

/** Hooks 设置页非敏感配置视图（不含秘密与完整命令输出）。 */
export interface HooksConfigView {
	/** Hooks 运行时总开关。 */
	readonly enabled: boolean;
	/** RTK 集成启用状态。 */
	readonly rtkEnabled: boolean;
	/** RTK 可执行文件绝对路径（可选，仅展示路径本身，非秘密）。 */
	readonly rtkExecutablePath?: string;
}

/** RTK 运行状态视图：有界，不含环境变量、完整命令输出或秘密。 */
export interface RtkStatusView {
	/** 是否可用（版本与 rewrite 能力均验证通过）。 */
	readonly available: boolean;
	/** RTK 版本（可用时存在）。 */
	readonly version?: string;
	/** 有界错误摘要（不可用时存在）。 */
	readonly error?: string;
	/** 最近一次检测时间戳（毫秒）。 */
	readonly lastDetectedAt?: number;
}

/** 固定样例改写测试结果（响应 testRtkRewrite）。 */
export interface HooksTestResultMessage {
	readonly command: 'hooksTestResult';
	/** 固定样例命令。 */
	readonly sample: string;
	/** 改写后的命令（成功时存在）。 */
	readonly rewritten?: string;
	/** 有界错误摘要（失败时存在）。 */
	readonly error?: string;
}

/** 设置页 Hooks 快照（响应 requestHooksSnapshot / 保存或检测成功后推送）。 */
export interface HooksSnapshotMessage {
	readonly command: 'hooksSnapshot';
	readonly config: HooksConfigView;
	/** RTK 运行状态（无检测记录时为 undefined）。 */
	readonly rtk?: RtkStatusView;
}

/** 设置页使用情况统计快照（响应 requestUsageStats，携带标准化粒度和区间）。 */
export interface UsageStatsMessage {
	readonly command: 'usageStats';
	/** 统计结果（粒度、起止区间、总量与模型明细；partial 表示部分归档不可读）。 */
	readonly payload: TokenUsageStatsResult;
}

/** 设置页使用情况请求的有界错误（仅整体失败时发送，不携带敏感信息）。 */
export interface UsageStatsErrorMessage {
	readonly command: 'usageStatsError';
	/** 可直接展示的中文错误消息。 */
	readonly message: string;
}

/** 扩展运行时初始化状态。 */
export type RuntimeStatus = 'initializing' | 'ready' | 'failed';

/** 宿主通知 Webview 当前运行时是否可执行聊天业务。 */
export interface RuntimeStateMessage {
	readonly command: 'runtimeState';
	readonly status: RuntimeStatus;
	readonly message?: string;
}

/** Host → Webview 判别联合。 */
export type HostToWebviewMessage =
	| RuntimeStateMessage
	| ApprovalModeMessage
	| ModelInfoMessage
	| ModelPickerMessage
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
	| ReplyChangeSetMessage
	| ChangeReviewSummaryMessage
	| ChangeReviewFileMessage
	| ToolCallMessage
	| ToolResultMessage
	| ThoughtMessage
	| ProgressMessage
	| PlanMessage
	| HistoryLoadedMessage
	| TodoStateMessage
	| PlanModeStateMessage
	| TriggerNewSessionMessage
	| ApprovalRequestMessage
	| WorkspaceFilesMessage
	| SessionListMessage
	| CurrentSessionDeletedMessage
	| RollbackRestoredMessage
	| ModelSettingsMessage
	| ModelSettingsSavedMessage
	| SkillsListMessage
	| SettingsErrorMessage
	| McpSettingsMessage
	| McpSettingsSavedMessage
	| McpOperationAcceptedMessage
	| McpSettingsErrorMessage
	| HooksSnapshotMessage
	| HooksTestResultMessage
	| UsageStatsMessage
	| UsageStatsErrorMessage;

// ── Webview → Host 消息 ──

/** 应用挂载完成握手：宿主随后推送模型名与斜杠命令初始数据。 */
export interface WebviewReadyMessage {
	readonly command: 'webviewReady';
}

/** 对话输入区请求切换当前工作区审批模式。 */
export interface SetApprovalModeMessage {
	readonly command: 'setApprovalMode';
	readonly mode: ApprovalMode;
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

/** 进入 Plan 模式（宿主动作，不发送聊天消息）。 */
export interface EnterPlanModeMessage {
	readonly command: 'enterPlanMode';
	readonly sessionId: string;
}

/** 继续规划（review → planning，保留当前草案）。 */
export interface ContinuePlanningMessage {
	readonly command: 'continuePlanning';
	readonly sessionId: string;
}

/** 退出 Plan 模式（回到 normal；按草案标记决定是否清空草案）。 */
export interface ExitPlanModeMessage {
	readonly command: 'exitPlanMode';
	readonly sessionId: string;
}

/** 确认执行计划（review → executing 并启动同会话隐藏执行指令）。 */
export interface ConfirmExecutionMessage {
	readonly command: 'confirmExecution';
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
/** 打开某条回复的独立代码变更页。 */
export interface OpenChangeReviewMessage {
	/** 消息命令名。 */
	readonly command: 'openChangeReview';
	/** 会话 ID。 */
	readonly sessionId: string;
	/** 变更集 ID。 */
	readonly changeSetId: string;
}

/** 独立变更页请求摘要。 */
export interface RequestChangeReviewMessage {
	/** 消息命令名。 */
	readonly command: 'requestChangeReview';
}

/** 独立变更页请求某文件详情。 */
export interface RequestChangeReviewFileMessage {
	/** 消息命令名。 */
	readonly command: 'requestChangeReviewFile';
	/** 文件稳定标识。 */
	readonly fileId: string;
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

/** 删除单条消息（宿主按角色补删配对消息并回推最新历史）。 */
export interface DeleteMessageMessage {
	readonly command: 'deleteMessage';
	readonly sessionId: string;
	/** 存储层消息序号 */
	readonly seq: number;
}

/** 回滚用户输入 turn（宿主弹确认框，恢复文件并截断消息）。 */
export interface RollbackTurnMessage {
	readonly command: 'rollbackTurn';
	readonly sessionId: string;
	/** 用户消息序号 */
	readonly seq: number;
}

/** 请求在编辑器中打开独立设置标签。 */
export interface OpenSettingsMessage {
	readonly command: 'openSettings';
}

/** 触发切换当前默认模型（/model 命令选中后发送，宿主弹模型选择列表）。 */
export interface SwitchModelMessage {
	readonly command: 'switchModel';
}

/** 请求手动压缩当前会话上下文。 */
export interface CompactContextMessage {
	readonly command: 'compactContext';
	readonly sessionId: string;
}

/** 请求已启用模型列表，以展示对话输入框的模型选择弹窗。 */
export interface RequestModelPickerMessage {
	readonly command: 'requestModelPicker';
}

/** 从对话输入框模型选择弹窗提交目标模型。 */
export interface SelectModelMessage {
	readonly command: 'selectModel';
	readonly modelId: string;
}

/** 设置页请求模型配置快照（挂载时发送）。 */
export interface RequestModelSettingsMessage {
	readonly command: 'requestModelSettings';
}

/** 设置页提交模型配置（含可选的新 API Key）。 */
export interface SaveModelSettingsMessage {
	readonly command: 'saveModelSettings';
	readonly model: ModelSettingsInput;
}

/** 设置指定模型为默认模型。 */
export interface SetDefaultModelMessage {
	/** 命令名。 */
	readonly command: 'setDefaultModel';
	/** 模型 ID。 */
	readonly modelId: string;
}

/** 更新指定模型的启用状态。 */
export interface SetModelEnabledMessage {
	/** 命令名。 */
	readonly command: 'setModelEnabled';
	/** 模型 ID。 */
	readonly modelId: string;
	/** 是否启用。 */
	readonly enabled: boolean;
}

/** 删除指定模型。 */
export interface DeleteModelMessage {
	/** 命令名。 */
	readonly command: 'deleteModel';
	/** 模型 ID。 */
	readonly modelId: string;
}

/** 设置页请求当前已加载 Skill 快照。 */
export interface RequestSkillsMessage {
	readonly command: 'requestSkills';
}

/** 设置页切换配置来源（none/claude/trae/agent，四值互斥）。 */
export interface SetSyncSourceMessage {
	readonly command: 'setSyncSource';
	readonly source: SyncSource;
}

/** 设置页保存 Skill 加载目录并请求重新加载。 */
export interface SetSkillDirectoriesMessage {
	readonly command: 'setSkillDirectories';
	/** 相对工作区根的 Skill 目录列表 */
	readonly directories: string[];
}

/** 设置页请求选择 ZIP 并自动解析安装项目 Skill。 */
export interface UploadSkillArchiveMessage {
	/** 命令名。 */
	readonly command: 'uploadSkillArchive';
}

/** 设置页请求 MCP 配置快照（MCP 分类挂载时发送）。 */
export interface RequestMcpSettingsMessage {
	readonly command: 'requestMcpSettings';
}

/** 设置页提交 MCP JSON 文本（新增/批量导入或编辑单个 Server）。 */
export interface SaveMcpServersJsonMessage {
	readonly command: 'saveMcpServersJson';
	/** `{ mcpServers: { ... } }` JSON 文本（env/header 明文仅在此单次消息中传输）。 */
	readonly json: string;
	/** 保存模式：add=新增/批量导入，edit=编辑 editingServerId。 */
	readonly mode: McpSaveMode;
	/** 编辑模式下的目标 Server ID；新增模式缺省。 */
	readonly editingServerId?: string;
}

/** 设置页切换 Server 启用状态（异步，Host 接受后推送最终状态）。 */
export interface SetMcpServerEnabledMessage {
	readonly command: 'setMcpServerEnabled';
	readonly serverId: string;
	readonly enabled: boolean;
}

/** 设置页请求重连指定 Server（不改配置，仅重建 Connection）。 */
export interface ReconnectMcpServerMessage {
	readonly command: 'reconnectMcpServer';
	readonly serverId: string;
}

/** 设置页请求删除指定 Server（前端二次确认后发送）。 */
export interface DeleteMcpServerMessage {
	readonly command: 'deleteMcpServer';
	readonly serverId: string;
}

/** 设置页请求 Hooks 配置与运行状态快照。 */
export interface RequestHooksSnapshotMessage {
	readonly command: 'requestHooksSnapshot';
}

/** 设置页保存 Hooks 配置（总开关 + RTK 启用状态 + 可选可执行文件路径）。 */
export interface SaveHooksConfigMessage {
	readonly command: 'saveHooksConfig';
	/** Hooks 运行时总开关。 */
	readonly enabled: boolean;
	/** RTK 集成启用状态。 */
	readonly rtkEnabled: boolean;
	/** RTK 可执行文件绝对路径（可选；空字符串视为清除）。 */
	readonly rtkExecutablePath?: string;
}

/** 设置页请求重新检测配置的 RTK 可执行文件。 */
export interface DetectRtkMessage {
	readonly command: 'detectRtk';
}

/** 设置页请求固定样例（git status）改写测试。 */
export interface TestRtkRewriteMessage {
	readonly command: 'testRtkRewrite';
}

/** 设置页使用情况请求指定粒度与参考日期的统计快照（进入该分类或筛选变化时发送）。 */
export interface RequestUsageStatsMessage {
	readonly command: 'requestUsageStats';
	/** 统计粒度：day（自然日）/ week（周一自然周）/ month（自然月）。 */
	readonly granularity: UsageGranularity;
	/** 参考日期（ISO 日期字符串，如 2026-08-15；宿主按本机时区确定所属区间）。 */
	readonly reference: string;
}

/** Webview → Host 判别联合。 */
export type WebviewToHostMessage =
	| WebviewReadyMessage
	| SetApprovalModeMessage
	| CreateSessionMessage
	| SendMessageMessage
	| StopStreamMessage
	| EnterPlanModeMessage
	| ContinuePlanningMessage
	| ExitPlanModeMessage
	| ConfirmExecutionMessage
	| LoadHistoryMessage
	| ApprovalDecisionMessage
	| OpenChangeReviewMessage
	| RequestChangeReviewMessage
	| RequestChangeReviewFileMessage
	| OpenFileMessage
	| RequestSlashCommandsMessage
	| RequestWorkspaceFilesMessage
	| RenameSessionMessage
	| RequestSessionsMessage
	| OpenSessionRequestMessage
	| DeleteSessionMessage
	| DeleteMessageMessage
	| RollbackTurnMessage
	| OpenSettingsMessage
	| SwitchModelMessage
	| CompactContextMessage
	| RequestModelPickerMessage
	| SelectModelMessage
	| RequestModelSettingsMessage
	| SaveModelSettingsMessage
	| SetDefaultModelMessage
	| SetModelEnabledMessage
	| DeleteModelMessage
	| RequestSkillsMessage
	| SetSyncSourceMessage
	| SetSkillDirectoriesMessage
	| UploadSkillArchiveMessage
	| RequestMcpSettingsMessage
	| SaveMcpServersJsonMessage
	| SetMcpServerEnabledMessage
	| ReconnectMcpServerMessage
	| DeleteMcpServerMessage
	| RequestHooksSnapshotMessage
	| SaveHooksConfigMessage
	| DetectRtkMessage
	| TestRtkRewriteMessage
	| RequestUsageStatsMessage;

/** 任一方向消息的命令名（用于日志与调试）。 */
export type MessageCommand = HostToWebviewMessage['command'] | WebviewToHostMessage['command'];
