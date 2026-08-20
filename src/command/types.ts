/**
 * Command 类型定义 - 自定义 Command（可复用提示词模板）的核心类型契约。
 *
 * Command 与 Skill 语义不同：Command 是最小格式的 Markdown 模板（仅正文必填），
 * 通过固定目录持久化，发送时仅作为模型输入文本，绝不执行正文中的任何代码。
 */

/** Command 来源作用域。 */
export type CommandScope = 'global' | 'project';

/** Command 定义（解析后的模型输入模板）。 */
export interface Command {
	/** 命令名（由文件名确定，不含 .md 后缀，如 review） */
	readonly name: string;
	/** 可选描述（来自 frontmatter description，无则缺省） */
	readonly description?: string;
	/** 正文（非空；仅作为模型输入文本，不执行） */
	readonly body: string;
	/** 来源作用域 */
	readonly scope: CommandScope;
	/** 来源文件绝对路径 */
	readonly sourcePath: string;
}

/** 单个作用域的命令物理快照：某固定目录下扫描出的全部 Command 文件（含被项目覆盖的全局项）。 */
export interface CommandScopeSnapshot {
	/** 作用域标识 */
	readonly scope: CommandScope;
	/** 该作用域命令目录绝对路径 */
	readonly directory: string;
	/** 该目录下解析成功的全部 Command（按名称排序） */
	readonly commands: readonly Command[];
}

/** 双作用域命令快照（设置页与管理服务的统一返回形状）。 */
export interface CommandSnapshot {
	/** 全局作用域快照 */
	readonly global: CommandScopeSnapshot;
	/** 项目作用域快照；未打开工作区时为 null */
	readonly project: CommandScopeSnapshot | null;
}
