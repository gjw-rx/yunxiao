/**
 * MCP 官方 TypeScript Client SDK 集中导入入口。
 *
 * 职责：把官方 Client 与三类 Transport（STDIO / Streamable HTTP / SSE）的
 * 导入路径收敛到本文件，避免在多个 Connection/Factory 文件中散落 SDK 路径，
 * 便于一次性升级与打包验证。SDK 版本：@modelcontextprotocol/sdk ^1.30.0。
 *
 * 兼容性：SDK engines node >=18，VS Code 1.106 Extension Host（Node 20）可用；
 * Node16 模块解析下使用带 `.js` 扩展的子路径，命中 SDK exports 的 `./*` 通配。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { McpError, ErrorCode, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export { Client, StdioClientTransport, StreamableHTTPClientTransport, StreamableHTTPError, SSEClientTransport, McpError, ErrorCode, ToolListChangedNotificationSchema };
export type { Transport };
