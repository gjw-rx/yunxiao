/**
 * Skill 类型定义 - Skill 系统的核心类型契约。
 */

/** Skill frontmatter（Markdown 文件头部的 YAML 元数据）。 */
export interface SkillFrontmatter {
	/** Skill 名称（唯一标识） */
	readonly name: string;
	/** 描述何时使用此 Skill */
	readonly description: string;
	/** 是否支持 / 命令触发 */
	readonly slash?: boolean;
	/** Skill 类型：agent=子智能体，skill=普通 Skill（缺省为 skill） */
	readonly type?: 'agent' | 'skill';
}

/** Skill 定义。 */
export interface Skill {
	/** Skill 名称（唯一标识） */
	readonly name: string;
	/** 描述何时使用此 Skill */
	readonly description: string;
	/** 是否支持 / 命令触发 */
	readonly slash?: boolean;
	/** Skill 类型：agent=子智能体，skill=普通 Skill（缺省为 skill） */
	readonly type?: 'agent' | 'skill';
	/** Markdown 正文（Skill 指令内容） */
	readonly content: string;
	/** 来源文件路径（目录加载时填充） */
	readonly sourcePath?: string;
}

/** Skill 来源类型。 */
export type SkillSource =
	| { readonly type: 'directory'; readonly path: string }
	| { readonly type: 'embedded'; readonly skill: Skill };
