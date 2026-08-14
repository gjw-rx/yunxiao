/**
 * 工具注册表 - 本地工具与动态 owner 工具的发现、注册与列举。
 *
 * 静态工具通过 register() 注册（扩展启动时一次性注册）；
 * 动态工具通过 registerOwnerTools/replaceOwnerTools/unregisterOwner 管理
 * （MCP Manager 按 Server 上线/下线/工具列表变化调用）。
 *
 * owner-scoped 注册保证原子性：替换失败时回滚到原有工具集。
 * 所有工具（静态+动态）共享同一 namespace，按 schema.name 唯一。
 */
import type { ToolSchema } from './types';
import type { BaseTool } from '../tools/baseTool';
import { ToolNotFoundError, InvalidArgumentsError } from './errors';
import { compileValidator } from './schemaValidator';
import * as logger from '../logger';

/** owner ID → 该 owner 注册的工具名集合（用于下线时批量移除）。 */
interface OwnerEntry {
	readonly toolNames: Set<string>;
}

export class ToolRegistry {
	private readonly tools = new Map<string, BaseTool>();
	/** 注册时编译的参数校验器缓存(toolName -> (args) => 错误列表)。 */
	private readonly validators = new Map<string, (args: Record<string, unknown>) => string[]>();
	/** owner ID → owner 条目（记录该 owner 注册的工具名集合）。 */
	private readonly owners = new Map<string, OwnerEntry>();

	/**
	 * 注册工具（schema + executor 由 BaseTool 封装）。重复名抛错。注册时编译参数校验器。
	 *
	 * 用于扩展启动时的静态工具注册；动态工具使用 registerOwnerTools。
	 */
	register(tool: BaseTool): void {
		const name = tool.schema.name;
		if (this.tools.has(name)) {
			throw new Error(`工具已注册，不可重复注册: ${name}`);
		}
		this.tools.set(name, tool);
		this.validators.set(name, compileValidator(tool.schema.parameters));
		logger.log('[ToolRegistry] 注册工具 tool=' + name);
	}

	/**
	 * 注册 owner 的工具集（原子：全注册或全不注册）。
	 *
	 * 用于 MCP Manager 在 Server 连接成功后批量注册工具。
	 * 如果任一工具名已被占用（静态工具或其他 owner 的工具），全部不注册。
	 *
	 * @param ownerId owner 标识（如 MCP Server ID）
	 * @param tools 该 owner 的工具列表
	 */
	registerOwnerTools(ownerId: string, tools: readonly BaseTool[]): void {
		// 冲突预检：任一工具名已存在则抛错，不部分注册
		for (const tool of tools) {
			if (this.tools.has(tool.schema.name)) {
				throw new Error(`工具已注册，不可重复注册: ${tool.schema.name}`);
			}
		}
		// 原子注册
		const toolNames = new Set<string>();
		for (const tool of tools) {
			const name = tool.schema.name;
			this.tools.set(name, tool);
			this.validators.set(name, compileValidator(tool.schema.parameters));
			toolNames.add(name);
		}
		this.owners.set(ownerId, { toolNames });
		logger.log(`[ToolRegistry] owner=${ownerId} 注册工具 count=${tools.length}`);
	}

	/**
	 * 原子替换 owner 的工具集：先保存旧工具，再注册新工具，失败时回滚。
	 *
	 * 替换失败（新工具名与已有非本 owner 工具冲突，或新工具集内部重名）
	 * 时回滚到原有工具集。
	 *
	 * @param ownerId owner 标识
	 * @param newTools 新的工具列表
	 */
	replaceOwnerTools(ownerId: string, newTools: readonly BaseTool[]): void {
		const oldEntry = this.owners.get(ownerId);
		const oldNames = oldEntry?.toolNames ?? new Set<string>();

		// 冲突预检：新工具名不得与非本 owner 的工具冲突
		for (const tool of newTools) {
			const name = tool.schema.name;
			if (this.tools.has(name) && !oldNames.has(name)) {
				throw new Error(`工具已注册，不可重复注册: ${name}`);
			}
		}

		// 保存旧工具引用（用于回滚）
		const oldTools = new Map<string, { tool: BaseTool; validator: (args: Record<string, unknown>) => string[] }>();
		if (oldEntry) {
			for (const name of oldEntry.toolNames) {
				const tool = this.tools.get(name);
				const validator = this.validators.get(name);
				if (tool && validator) {
					oldTools.set(name, { tool, validator });
				}
			}
			// 移除旧工具
			for (const name of oldEntry.toolNames) {
				this.tools.delete(name);
				this.validators.delete(name);
			}
		}

		// 注册新工具（检测内部重名）
		const toolNames = new Set<string>();
		for (const tool of newTools) {
			const name = tool.schema.name;
			if (this.tools.has(name)) {
				// 内部重名或预检遗漏：回滚到旧工具
				this._restoreOldTools(oldTools);
				throw new Error(`工具已注册，不可重复注册: ${name}`);
			}
			this.tools.set(name, tool);
			this.validators.set(name, compileValidator(tool.schema.parameters));
			toolNames.add(name);
		}
		this.owners.set(ownerId, { toolNames });
		logger.log(`[ToolRegistry] owner=${ownerId} 替换工具 count=${newTools.length}`);
	}

	/**
	 * 下线 owner 的全部工具。owner 不存在时幂等返回。
	 *
	 * @param ownerId owner 标识
	 */
	unregisterOwner(ownerId: string): void {
		const entry = this.owners.get(ownerId);
		if (!entry) {
			return;
		}
		for (const name of entry.toolNames) {
			this.tools.delete(name);
			this.validators.delete(name);
		}
		this.owners.delete(ownerId);
		logger.log(`[ToolRegistry] owner=${ownerId} 下线工具 count=${entry.toolNames.size}`);
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

	// ── 内部辅助 ──

	/** 回滚：恢复旧 owner 工具集（replaceOwnerTools 注册失败时调用）。 */
	private _restoreOldTools(oldTools: Map<string, { tool: BaseTool; validator: (args: Record<string, unknown>) => string[] }>): void {
		for (const [name, { tool, validator }] of oldTools) {
			this.tools.set(name, tool);
			this.validators.set(name, validator);
		}
	}
}
