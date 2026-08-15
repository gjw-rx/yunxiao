/**
 * MCP 集成共享类型契约。
 *
 * 职责：集中定义 MCP 配置存储文档、STDIO/Streamable HTTP 配置判别联合、
 * 运行时 Server 状态、实际 Transport、动态工具目录、instructions 快照与
 * 结果元数据。所有模块（ConfigStore、ClientManager、Connection、ToolAdapter、
 * 设置页协议）均依赖本文件，不在此处引入运行时依赖。
 *
 * 安全约定：
 * - 带 `Input` 后缀的类型来自 Webview JSON，env/header 值可能含秘密占位，不可信任；
 * - 不带后缀的归一化配置只保留 env key/header name 列表，值存 SecretStorage；
 * - `Runtime` 后缀的类型已装配秘密值，仅在 Host 进程内使用，绝不回传 Webview。
 */

// ── 秘密占位 ──

/** 编辑现有 Server 时替代 env/header 明文的固定占位值。 */
export const MCP_SECRET_PLACEHOLDER = '<已安全保存>';

// ── 用户 JSON 输入形态（不可信任，env/header 值可能为占位）──

/** STDIO Server 的用户 JSON 输入形态。 */
export interface StdioMcpConfigInput {
	/** Transport 类型固定为 stdio。 */
	readonly type: 'stdio';
	/** 待启动的可执行文件（必填，非空）。 */
	readonly command: string;
	/** 命令行参数（字符串数组，不经 shell 拼接）。 */
	readonly args?: readonly string[];
	/** 环境变量（值可能为占位或明文，全量进 SecretStorage）。 */
	readonly env?: Readonly<Record<string, string>>;
	/** 工作目录（缺省为当前主工作区根；相对路径以工作区为根）。 */
	readonly cwd?: string;
	/** 是否启用，缺省 true。 */
	readonly enabled?: boolean;
	/** 连接/初始化超时（毫秒）。 */
	readonly connectTimeoutMs?: number;
	/** 单次 tools/call 超时（毫秒）。 */
	readonly callTimeoutMs?: number;
}

/** Streamable HTTP Server 的用户 JSON 输入形态。 */
export interface StreamableHttpMcpConfigInput {
	/** Transport 类型固定为 streamable-http。 */
	readonly type: 'streamable-http';
	/** 远程 MCP endpoint（必须 HTTPS，loopback 允许 HTTP）。 */
	readonly url: string;
	/** 静态请求 headers（值可能为占位或明文，全量进 SecretStorage）。 */
	readonly headers?: Readonly<Record<string, string>>;
	/** 是否在 Streamable HTTP 兼容失败时回退 legacy SSE。 */
	readonly legacySseFallback?: boolean;
	/** 是否启用，缺省 true。 */
	readonly enabled?: boolean;
	/** 连接/初始化超时（毫秒）。 */
	readonly connectTimeoutMs?: number;
	/** 单次 tools/call 超时（毫秒）。 */
	readonly callTimeoutMs?: number;
}

/** 任一 Transport 的用户输入配置（判别联合，按 type 区分）。 */
export type McpServerConfigInput = StdioMcpConfigInput | StreamableHttpMcpConfigInput;

/** 设置页 JSON 顶层结构：`{ "mcpServers": { ... } }`。 */
export interface McpServersJsonInput {
	readonly mcpServers: Readonly<Record<string, McpServerConfigInput>>;
}

// ── 归一化持久化配置（非敏感，写入 servers.json）──

/** 已归一化的 STDIO 配置：env 只保留 key 列表，值存 SecretStorage。 */
export interface StdioMcpConfig {
	readonly type: 'stdio';
	readonly command: string;
	readonly args: readonly string[];
	/** env 变量名列表（不含值）。 */
	readonly envKeys: readonly string[];
	/** 工作目录（已解析为绝对路径；缺省时由运行时按工作区展开）。 */
	readonly cwd?: string;
	readonly enabled: boolean;
	readonly connectTimeoutMs: number;
	readonly callTimeoutMs: number;
}

/** 已归一化的 Streamable HTTP 配置：headers 只保留 name 列表，值存 SecretStorage。 */
export interface StreamableHttpMcpConfig {
	readonly type: 'streamable-http';
	readonly url: string;
	/** header name 列表（不含值）。 */
	readonly headerNames: readonly string[];
	readonly legacySseFallback: boolean;
	readonly enabled: boolean;
	readonly connectTimeoutMs: number;
	readonly callTimeoutMs: number;
}

/** 归一化 Server 配置（判别联合）。 */
export type McpServerConfig = StdioMcpConfig | StreamableHttpMcpConfig;

// ── Store 文档 ──

/** 用户级私有 MCP 配置文档（非敏感，保存于 ~/.yunForce/mcp/servers.json）。 */
export interface McpConfigDocument {
	readonly version: 1;
	/** 递增 revision，Manager 据此丢弃过期事件。 */
	readonly revision: number;
	/** Server ID → 归一化配置。 */
	readonly servers: Readonly<Record<string, McpServerConfig>>;
}

// ── 运行时配置（秘密已装配，仅 Host 内使用）──

/** 运行时 STDIO 配置：env 值已从 SecretStorage 装配。 */
export interface StdioMcpRuntimeConfig extends Omit<StdioMcpConfig, 'envKeys'> {
	readonly type: 'stdio';
	readonly env: Readonly<Record<string, string>>;
}

/** 运行时 Streamable HTTP 配置：header 值已从 SecretStorage 装配。 */
export interface StreamableHttpMcpRuntimeConfig extends Omit<StreamableHttpMcpConfig, 'headerNames'> {
	readonly type: 'streamable-http';
	readonly headers: Readonly<Record<string, string>>;
}

/** 运行时 Server 配置（判别联合，含秘密值）。 */
export type McpServerRuntimeConfig = StdioMcpRuntimeConfig | StreamableHttpMcpRuntimeConfig;

// ── 运行状态 ──

/** MCP Server 运行状态。 */
export type McpServerStatus =
	| 'disabled'
	| 'waiting_workspace_trust'
	| 'connecting'
	| 'ready'
	| 'reconnecting'
	| 'error'
	| 'stopping';

/** 实际建立连接的 Transport（远程可能回退为 legacy-sse）。 */
export type McpActualTransport = 'stdio' | 'streamable-http' | 'legacy-sse';

// ── 工具目录 ──

/** MCP 工具 annotations 子集（仅取权限相关字段）。 */
export interface McpToolAnnotations {
	readonly readOnlyHint?: boolean;
	readonly destructiveHint?: boolean;
	readonly openWorldHint?: boolean;
}

/** 动态工具目录项：暴露名 ↔ Server/原始工具名的不可变映射。 */
export interface McpToolCatalogEntry {
	/** 所属 Server ID。 */
	readonly serverId: string;
	/** Server 端原始 MCP 工具名。 */
	readonly nativeToolName: string;
	/** 模型可见的 namespaced 暴露名（mcp__<server>__<tool>）。 */
	readonly exposedName: string;
	readonly description: string;
	/** MCP inputSchema（原样复用，缺失时为禁止额外字段的空对象）。 */
	readonly inputSchema: Record<string, unknown>;
	readonly annotations?: McpToolAnnotations;
}

/** Connection 发现的原始 MCP 工具（未经命名映射，供 Manager 构建目录）。 */
export interface McpDiscoveredTool {
	/** Server 端原始 MCP 工具名。 */
	readonly nativeToolName: string;
	readonly description: string;
	/** MCP inputSchema（原样复用）。 */
	readonly inputSchema: Record<string, unknown>;
	readonly annotations?: McpToolAnnotations;
}

// ── instructions 快照 ──

/** 单 Server instructions 的不可变、有界快照。 */
export interface McpServerInstructions {
	readonly serverId: string;
	/** 已按单项上限截断的内容。 */
	readonly content: string;
	readonly truncated: boolean;
}

// ── 设置页视图（非敏感，回传 Webview）──

/** 设置页展示的单个 MCP 工具（仅名称与 description）。 */
export interface McpToolView {
	readonly name: string;
	readonly description: string;
}

/** STDIO 配置的非敏感视图（无 env 值，仅 key 列表）。 */
export interface StdioMcpConfigView {
	readonly type: 'stdio';
	readonly command: string;
	readonly args: readonly string[];
	readonly envKeys: readonly string[];
	readonly cwd?: string;
	readonly enabled: boolean;
	readonly connectTimeoutMs: number;
	readonly callTimeoutMs: number;
}

/** Streamable HTTP 配置的非敏感视图（无 header 值，仅 name 列表）。 */
export interface StreamableHttpMcpConfigView {
	readonly type: 'streamable-http';
	readonly url: string;
	readonly headerNames: readonly string[];
	readonly legacySseFallback: boolean;
	readonly enabled: boolean;
	readonly connectTimeoutMs: number;
	readonly callTimeoutMs: number;
}

/** 归一化配置的非敏感视图（判别联合）。 */
export type McpServerConfigView = StdioMcpConfigView | StreamableHttpMcpConfigView;

/** 设置页展示的单个 Server 视图（无任何秘密明文）。 */
export interface McpServerView {
	readonly id: string;
	/** 用户配置的 Transport（stdio / streamable-http）。 */
	readonly configuredTransport: 'stdio' | 'streamable-http';
	/** 实际建立连接的 Transport（远程可能为 legacy-sse）。 */
	readonly actualTransport?: McpActualTransport;
	readonly enabled: boolean;
	readonly status: McpServerStatus;
	readonly toolCount: number;
	readonly tools: readonly McpToolView[];
	/** 有界错误摘要（不含秘密/堆栈/完整响应正文）。 */
	readonly errorSummary?: string;
	/** 非敏感配置视图（供列表详情展示）。 */
	readonly config: McpServerConfigView;
}

/** 设置页 MCP 完整快照（响应 requestMcpSettings / 状态推送）。 */
export interface McpSettingsSnapshot {
	readonly servers: readonly McpServerView[];
}

// ── 编辑预填视图（单 Server JSON + 秘密占位）──

/** STDIO 编辑预填（env 值替换为占位）。 */
export interface StdioMcpEditView {
	readonly type: 'stdio';
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly cwd?: string;
	readonly enabled: boolean;
	readonly connectTimeoutMs: number;
	readonly callTimeoutMs: number;
}

/** Streamable HTTP 编辑预填（header 值替换为占位）。 */
export interface StreamableHttpMcpEditView {
	readonly type: 'streamable-http';
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly legacySseFallback: boolean;
	readonly enabled: boolean;
	readonly connectTimeoutMs: number;
	readonly callTimeoutMs: number;
}

/** 编辑预填配置（判别联合，env/header 值为占位）。 */
export type McpServerEditView = StdioMcpEditView | StreamableHttpMcpEditView;

// ── 结果元数据 ──

/** MCP 结果归一化附加元数据。 */
export interface McpResultMetadata {
	/** 结果含被跳过/描述化的非文本内容（image/audio/blob）。 */
	readonly unsupportedContent?: boolean;
	/** 内容来自 MCP isError。 */
	readonly isError?: boolean;
	/** 结果被脱敏。 */
	readonly redacted?: boolean;
	/** 结果被截断。 */
	readonly truncated?: boolean;
	/** 失败是否可在模型重新规划后重试（业务调用一律 false）。 */
	readonly retryable?: boolean;
	/** 调用可能已到达 Server 但结果未确认。 */
	readonly execution_state?: 'unknown';
}

// ── 错误分类 ──

/** MCP 失败类别（用于状态摘要、重试策略与 SSE 回退判定）。 */
export type McpErrorCategory =
	| 'config_validation'
	| 'secret_missing'
	| 'workspace_untrusted'
	| 'spawn'
	| 'dns_tls'
	| 'http_auth'
	| 'http_status'
	| 'transport_mismatch'
	| 'protocol'
	| 'discovery'
	| 'tool_isError'
	| 'timeout'
	| 'cancelled'
	| 'connection_closed'
	| 'normalization'
	| 'unknown';

/** 结构化 MCP 失败（携带类别与可读消息，不含秘密）。 */
export interface McpError {
	readonly category: McpErrorCategory;
	readonly message: string;
	/** 是否可重试（控制面有界重试用；业务调用一律 false）。 */
	readonly retryable: boolean;
}
