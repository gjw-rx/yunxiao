/**
 * 统一错误类型与用户友好提示映射。
 * 各模块抛出语义化错误，UI/协议层经 formatErrorForUser 转为用户可读消息。
 */

/** 路径安全守卫错误（越界、敏感文件、无工作区等）。 */
export class PathGuardError extends Error {
	constructor(
		message: string,
		readonly kind: 'traversal' | 'no_workspace' | 'not_found' | 'symlink_escape' | 'sensitive'
	) {
		super(message);
		this.name = 'PathGuardError';
	}
}

/** 工具未在注册表中找到。 */
export class ToolNotFoundError extends Error {
	constructor(toolName: string) {
		super(`未找到工具: ${toolName}`);
		this.name = 'ToolNotFoundError';
	}
}

/** 工具执行超时。 */
export class ToolTimeoutError extends Error {
	constructor(toolName: string, timeoutMs: number) {
		super(`工具 ${toolName} 执行超时（${timeoutMs}ms）`);
		this.name = 'ToolTimeoutError';
	}
}

/** 协议层错误（SSE 解析、/tool_result 调用失败等）。 */
export class ProtocolError extends Error {
	constructor(
		message: string,
		readonly statusCode?: number
	) {
		super(message);
		this.name = 'ProtocolError';
	}
}

/** 已建立的流式连接意外中断。 */
export class TransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TransportError';
	}
}

/** 工具参数校验错误。 */
export class ToolValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ToolValidationError';
	}
}

/**
 * 工具参数不符合 schema 的校验错误。
 * 文案含具体字段明细与"请重写输入以满足 schema"的指导语,便于模型修正后重试。
 */
export class InvalidArgumentsError extends ToolValidationError {
	constructor(toolName: string, details: readonly string[]) {
		super(
			`工具 ${toolName} 参数无效: ${details.join('; ')}。` +
				'Please rewrite the input so it satisfies the expected schema.'
		);
		this.name = 'InvalidArgumentsError';
	}
}

/** 将任意错误转为用户可读的友好提示。 */
export function formatErrorForUser(err: unknown): string {
	if (err instanceof PathGuardError) {
		switch (err.kind) {
			case 'traversal':
				return `路径越界，已被安全守卫拦截: ${err.message}`;
			case 'no_workspace':
				return '未打开工作区，无法执行文件操作';
			case 'symlink_escape':
				return `符号链接指向工作区外，已被拦截: ${err.message}`;
			case 'sensitive':
				return `访问敏感文件，需额外审批: ${err.message}`;
			default:
				return err.message;
		}
	}
	if (err instanceof ToolNotFoundError) {
		return err.message;
	}
	if (err instanceof ToolTimeoutError) {
		return err.message;
	}
	if (err instanceof ToolValidationError) {
		return `工具参数无效: ${err.message}`;
	}
	if (err instanceof ProtocolError) {
		return err.message;
	}
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}
