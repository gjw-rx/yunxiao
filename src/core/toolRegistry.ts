/**
 * 工具注册表 - 本地工具的发现、注册与列举。
 * 工具按 namespaced name（如 fs.read_file）唯一注册，供路由层与 LLM 工具定义转换使用。
 */
import type { ToolSchema } from './types';
import type { BaseTool } from '../tools/baseTool';
import { ToolNotFoundError } from './errors';

export class ToolRegistry {
	private readonly tools = new Map<string, BaseTool>();

	/** 注册工具（schema + executor 由 BaseTool 封装）。重复名抛错。 */
	register(tool: BaseTool): void {
		const name = tool.schema.name;
		if (this.tools.has(name)) {
			throw new Error(`工具已注册，不可重复注册: ${name}`);
		}
		this.tools.set(name, tool);
	}

	/** 按名查找工具，未找到抛 ToolNotFoundError。 */
	lookup(name: string): BaseTool {
		const tool = this.tools.get(name);
		if (!tool) {
			throw new ToolNotFoundError(name);
		}
		return tool;
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
