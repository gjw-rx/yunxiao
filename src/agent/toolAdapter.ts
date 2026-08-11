/**
 * 类型适配层 - LLM 层与 core 层之间的类型转换。
 *
 * LLM 层使用 id/name/arguments(JSON 字符串)，
 * core 层使用 call_id/tool/args(对象)/site，
 * 本模块提供纯函数在这两种格式间转换。
 *
 * 另提供 ToolSchema → AI SDK tool 定义转换（Task 3.1）：
 * 仅暴露 description + inputSchema（注册的 JSON Schema），
 * 禁止为本地工具注册 AI SDK execute 回调，确保本地执行只经 ToolRouter。
 */
import type { ToolDefinition, LLMToolCall } from '../llm/types';
import type { ToolSchema, ToolCall, ToolResult } from '../core/types';
import { tool, jsonSchema, type Tool } from 'ai';
import * as logger from '../logger';

/** 将 core 层 ToolSchema 转换为 LLM 层 ToolDefinition，丢弃 permissions/site/canParallel。 */
export function toolSchemaToDefinition(schema: ToolSchema): ToolDefinition {
	return {
		name: schema.name,
		description: schema.description,
		parameters: schema.parameters,
	};
}

/** 批量转换。 */
export function toolSchemasToDefinitions(schemas: readonly ToolSchema[]): ToolDefinition[] {
	if (schemas.length === 0) {
		logger.log('[ToolAdapter] 转换工具定义数量为 0，LLM 将无工具可用');
	}
	return schemas.map(toolSchemaToDefinition);
}

/**
 * 将单个 ToolSchema 转换为 AI SDK 工具定义。
 * 不注册 execute 回调：模型只看到 schema，工具执行仍由 AgentLoop → ToolRouter 完成。
 */
export function toolSchemaToAiSdkTool(schema: ToolSchema): Tool {
	return tool({
		description: schema.description,
		inputSchema: jsonSchema(schema.parameters),
	});
}

/**
 * 批量将 ToolRegistry schema 转换为 AI SDK 工具定义表（name → Tool）。
 * 每个工具均无 execute 回调。
 */
export function toolSchemasToAiSdkTools(schemas: readonly ToolSchema[]): Record<string, Tool> {
	const result: Record<string, Tool> = {};
	for (const schema of schemas) {
		result[schema.name] = toolSchemaToAiSdkTool(schema);
	}
	return result;
}

/** 将 LLM 返回的工具调用转换为 core 层 ToolCall 格式。arguments 解析失败时 args 设为 {}。 */
export function llmToolCallToCoreToolCall(llmCall: LLMToolCall): ToolCall {
	let args: Record<string, unknown>;
	try {
		args = JSON.parse(llmCall.arguments);
	} catch {
		args = {};
	}
	return {
		call_id: llmCall.id,
		tool: llmCall.name,
		args,
	};
}

/** 将工具执行结果转换为 tool 消息的 content 字符串。 */
export function toolResultToContent(result: ToolResult): string {
	switch (result.status) {
		case 'success':
			return result.result ?? '';
		case 'error':
			return `Error: ${result.error ?? '未知错误'}`;
		case 'cancelled':
			return `Cancelled: ${result.error ?? '用户取消'}`;
	}
}
