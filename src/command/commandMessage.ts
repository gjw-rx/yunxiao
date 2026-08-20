/**
 * Command 消息展开 - 将生效 Command 正文与用户补充说明按边界组装为本轮模型输入。
 *
 * 组装顺序：文件上下文 → Command 展开块 → Skill 引用 → 用户补充说明。
 * 正文与补充文本均仅作为模型输入文本，绝不执行。
 */
import type { Command } from './types';

/** 组装 Command 消息的上下文（各块均可选，仅组合存在部分）。 */
export interface CommandMessageContext {
	/** 生效的 Command（Host 发送时从最新注册表解析，不信任 Webview 传入正文） */
	readonly command: Command;
	/** 用户补充文本（可为空；空时省略补充说明区块） */
	readonly userText: string;
	/** 引用文件上下文块（可选，位于 Command 展开块之前） */
	readonly fileContext?: string;
	/** Skill 引用块（可选，位于 Command 展开块与补充说明之间） */
	readonly skillBlock?: string;
}

/**
 * 按边界组装含 Command 展开的模型输入。
 *
 * 输出格式（示例）：
 * <file context>
 *
 * [Command: review]
 * <command body>
 *
 * /skill1
 *
 * [用户补充说明]
 * <user text>
 *
 * @param ctx 组装上下文
 * @returns 组装后的模型输入文本
 */
export function buildCommandMessage(ctx: CommandMessageContext): string {
	const parts: string[] = [];
	if (ctx.fileContext) {
		parts.push(ctx.fileContext);
	}
	parts.push(`[Command: ${ctx.command.name}]\n${ctx.command.body}`);
	if (ctx.skillBlock) {
		parts.push(ctx.skillBlock);
	}
	const supplement = ctx.userText.trim();
	if (supplement) {
		parts.push(`[用户补充说明]\n${supplement}`);
	}
	return parts.join('\n\n');
}
