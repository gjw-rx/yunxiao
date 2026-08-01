/**
 * 工具基类 - 所有本地工具实现的抽象契约。
 * 子类提供 schema（元数据）与 execute（执行逻辑），可选覆盖 validate（参数校验）。
 */
import type { ToolSchema, ToolResult } from '../core/types';
import { ToolValidationError } from '../core/errors';

/** 工具执行上下文，由会话层装配并注入。 */
export interface ToolContext {
	/** 工作区根列表（供文件工具经 pathGuard 解析）。 */
	readonly workspaceRoots: string[];
	/** 读文件大小上限（字节）。 */
	readonly maxFileSize?: number;
	/** 工具执行超时（毫秒）。 */
	readonly toolTimeoutMs?: number;
	/** 用户警告回调（如敏感文件访问），由会话层桥接到 UI。 */
	readonly warn?: (message: string) => void;
	/** 未来扩展：审批网关回调等（Phase 2+）。 */
}

/** 工具执行返回（不含 call_id，由路由层按 call_id 盖戳）。 */
export type ToolExecutionResult = Omit<ToolResult, 'call_id'>;

/** 抽象工具基类。 */
export abstract class BaseTool {
	/** 工具元数据（名称、参数 schema、权限、执行位置）。 */
	abstract readonly schema: ToolSchema;

	/** 参数校验：非法时抛 ToolValidationError。默认无校验，子类按需覆盖。 */
	validate(_args: Record<string, unknown>): void {
		// 默认无校验
	}

	/** 执行工具，返回结构化结果（不含 tool_call_id）。 */
	abstract execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult>;

	/** 便捷访问权限级别。 */
	get permission(): ToolSchema['permissions'] {
		return this.schema.permissions;
	}
}

/** 校验参数为非空字符串，否则抛 ToolValidationError。供子类复用。 */
export function requireStringArg(args: Record<string, unknown>, name: string): string {
	const value = args[name];
	if (typeof value !== 'string' || value.length === 0) {
		throw new ToolValidationError(`参数 ${name} 必须为非空字符串`);
	}
	return value;
}
