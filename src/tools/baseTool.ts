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
	/** 当前会话 ID（供审批网关做会话级允许记忆）。 */
	readonly sessionId?: string;
	/** 当前云端 Run ID；旧 v1 流可能缺失。 */
	readonly runId?: string;
	/** 用户警告回调（如敏感文件访问），由会话层桥接到 UI。 */
	readonly warn?: (message: string) => void;
	/** 终端输出截断上限（字符），保留尾部。 */
	readonly terminalOutputLimit?: number;
	/** 取消信号（终端长任务用），触发时工具应中止并返回 cancelled。 */
	readonly abortSignal?: AbortSignal;
	/** 回传云端前允许的最大文本长度。 */
	readonly toolResultLimit?: number;
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

	/**
	 * 是否自行处理审批（如 code.edit 需先展示 diff 预览再确认）。
	 * 默认 false：由路由层统一审批。true 时路由层跳过审批，工具在 execute 内自行弹窗。
	 */
	readonly handlesOwnApproval: boolean = false;

	/**
	 * 所有工具结果回传云端前的统一治理：跳过二进制、裁剪超大文本、脱敏高置信度密钥。
	 * 工具仍可自行提供细粒度截断；该层是最后一道防线。
	 */
	governResult(result: ToolExecutionResult, context: ToolContext): ToolExecutionResult {
		if (!result.result) {
			return result;
		}

		const metadata = { ...result.metadata };
		let value = result.result;
		if (value.includes('\0')) {
			return {
				...result,
				result: '<binary content>',
				metadata: { ...metadata, truncated: true },
			};
		}

		const redacted = redactSecrets(value);
		if (redacted !== value) {
			value = redacted;
			metadata.redacted = true;
		}

		const limit = context.toolResultLimit ?? 10_000;
		if (value.length > limit) {
			const head = Math.min(2_000, Math.floor(limit / 2));
			const tail = Math.max(0, limit - head);
			value = `${value.slice(0, head)}\n...（结果已裁剪）...\n${value.slice(-tail)}`;
			metadata.truncated = true;
		}

		return { ...result, result: value, metadata };
	}
}

/** 仅处理 key=value / JSON key:value 等高置信度秘密模式，避免误伤普通文本。 */
function redactSecrets(value: string): string {
	return value
		.replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*["']?)[^\s"',;]+/gi, '$1***')
		.replace(/("(?:api[_-]?key|token|password|secret)"\s*:\s*")[^"]+/gi, '$1***');
}

/** 校验参数为非空字符串，否则抛 ToolValidationError。供子类复用。 */
export function requireStringArg(args: Record<string, unknown>, name: string): string {
	const value = args[name];
	if (typeof value !== 'string' || value.length === 0) {
		throw new ToolValidationError(`参数 ${name} 必须为非空字符串`);
	}
	return value;
}
