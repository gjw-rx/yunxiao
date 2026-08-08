/**
 * 类型适配层 - LLM 层与 core 层之间的类型转换。
 *
 * LLM 层使用 id/name/arguments(JSON 字符串)，
 * core 层使用 call_id/tool/args(对象)/site，
 * 本模块提供纯函数在这两种格式间转换。
 */
import type { ToolDefinition, LLMToolCall } from '../llm/types';
import type { ToolSchema, ToolCall, ToolResult } from '../core/types';

/** 将 core 层 ToolSchema 转换为 LLM 层 ToolDefinition，丢弃 permissions/site/canParallel。 */
export function toolSchemaToDefinition(schema: ToolSchema): ToolDefinition {
	return {
		name: schema.name,
		description: schema.description,
		parameters: schema.parameters,
	};
}

/** 批量转换，仅保留 site='local' 的工具。 */
export function toolSchemasToDefinitions(schemas: readonly ToolSchema[]): ToolDefinition[] {
	return schemas
		.filter((s) => s.site === 'local')
		.map(toolSchemaToDefinition);
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
		site: 'local' as const,
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
