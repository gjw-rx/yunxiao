/**
 * 工具注册表 - 本地工具的发现、注册与列举。
 * 工具按 namespaced name（如 fs_read_file）唯一注册，供路由层与 LLM 工具定义转换使用。
 */
import type { ToolSchema } from './types';
import type { BaseTool } from '../tools/baseTool';
import { ToolNotFoundError, InvalidArgumentsError } from './errors';
import { compileValidator } from './schemaValidator';
import * as logger from '../logger';

export class ToolRegistry {
	private readonly tools = new Map<string, BaseTool>();
	/** 注册时编译的参数校验器缓存(toolName -> (args) => 错误列表)。 */
	private readonly validators = new Map<string, (args: Record<string, unknown>) => string[]>();

	/** 注册工具（schema + executor 由 BaseTool 封装）。重复名抛错。注册时编译参数校验器。 */
	register(tool: BaseTool): void {
		const name = tool.schema.name;
		if (this.tools.has(name)) {
			throw new Error(`工具已注册，不可重复注册: ${name}`);
		}
		this.tools.set(name, tool);
		this.validators.set(name, compileValidator(tool.schema.parameters));
		logger.log('[ToolRegistry] 注册工具 tool=' + name);
	}

	/** 按名查找工具，未找到抛 ToolNotFoundError。 */
	lookup(name: string): BaseTool {
		const tool = this.tools.get(name);
		if (!tool) {
			throw new ToolNotFoundError(name);
		}
		return tool;
	}

	/**
	 * 校验工具参数:先按注册时的 JSON Schema 校验,再执行子类手写 validate。
	 * schema 校验失败抛 InvalidArgumentsError(含重写指导文案)。
	 * @param toolName 工具名
	 * @param args 实际调用参数
	 */
	validateArgs(toolName: string, args: Record<string, unknown>): void {
		const validator = this.validators.get(toolName);
		if (validator) {
			const errors = validator(args);
			if (errors.length > 0) {
				logger.log(`[ToolRegistry] 参数校验失败 tool=${toolName} errors=${errors.join('; ')}`);
				throw new InvalidArgumentsError(toolName, errors);
			}
		}
		this.lookup(toolName).validate(args);
	}

	/** 是否已注册。 */
	has(name: string): boolean {
		return this.tools.has(name);
	}

	/** 列举所有工具 schema。 */
	list(): ToolSchema[] {
		return [...this.tools.values()].map((t) => t.schema);
	}
}
