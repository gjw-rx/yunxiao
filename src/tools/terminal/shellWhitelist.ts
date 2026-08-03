/**
 * 命令白名单/危险拦截器 - terminal.exec 的安全前置层。
 *
 * 三分类：
 * - dangerous：命中硬编码危险模式（rm -rf、重定向、管道、命令分隔等）-> 直接拦截，不弹审批。
 * - whitelisted：匹配配置的安全命令前缀 -> 自动放行，不弹审批。
 * - unknown：其余命令 -> 走 ApprovalGateway 审批。
 *
 * 匹配优先级：dangerous > whitelisted > unknown。
 * 危险模式硬编码不可配置，防止用户误放行。
 */
export type CommandCategory = 'dangerous' | 'whitelisted' | 'unknown';

export interface ClassifyResult {
	readonly category: CommandCategory;
	/** dangerous 时的命中原因（危险模式名）。 */
	readonly reason?: string;
}

/** 硬编码危险模式（大小写不敏感）。不可配置。 */
const DANGEROUS_PATTERNS: readonly { pattern: RegExp; name: string }[] = [
	{ pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, name: 'rm -rf' },
	{ pattern: /\brm\s+-[a-z]*r\b/i, name: 'rm -r' },
	{ pattern: /\brmdir\s+\/s\b/i, name: 'rmdir /s' },
	{ pattern: /(^|[^|])\|\s*(sh|bash)\b/i, name: 'pipe to shell' },
	{ pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash)\b/i, name: 'curl|sh' },
	{ pattern: /\bsudo\b/i, name: 'sudo' },
	{ pattern: /\bchmod\s+777\b/i, name: 'chmod 777' },
	{ pattern: /\bchown\b/i, name: 'chown' },
	{ pattern: /\bmkfs\b/i, name: 'mkfs' },
	{ pattern: /\bdd\s+if=/i, name: 'dd if=' },
	{ pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;?\s*:/, name: 'fork bomb' },
	{ pattern: /\bgit\s+push\s+(-f|--force)/i, name: 'git push --force' },
	{ pattern: /\bgit\s+reset\s+--hard\b/i, name: 'git reset --hard' },
	// shell 操作符：重定向、管道、命令分隔
	{ pattern: />>?/i, name: 'output redirection' },
	{ pattern: /\|/i, name: 'pipe operator' },
	{ pattern: /;/, name: 'command separator ;' },
	{ pattern: /&&/, name: 'command chain &&' },
	{ pattern: /\|\|/, name: 'command chain ||' },
];

/** 默认白名单（与 package.json 配置默认值一致）。 */
export const DEFAULT_SHELL_WHITELIST: readonly string[] = [
	'npm test',
	'npm run lint',
	'npm run build',
	'npm run check',
	'git status',
	'git diff',
	'git log',
	'git branch',
	'node -v',
	'npm -v',
	'tsc --noEmit',
	'python -m pytest',
	'go test',
	'cargo test',
];

export class ShellWhitelist {
	private readonly whitelist: string[];

	constructor(whitelist?: string[]) {
		this.whitelist = whitelist ?? [...DEFAULT_SHELL_WHITELIST];
	}

	/**
	 * 分类命令：dangerous 优先 > whitelisted > unknown。
	 * @param command 要分类的 shell 命令
	 * @returns 分类结果，dangerous 时含 reason
	 */
	classify(command: string): ClassifyResult {
		// 1. 危险模式（任一命中即拦截）
		for (const { pattern, name } of DANGEROUS_PATTERNS) {
			if (pattern.test(command)) {
				return { category: 'dangerous', reason: name };
			}
		}

		// 2. 白名单前缀匹配
		const trimmed = command.trim();
		for (const entry of this.whitelist) {
			if (trimmed.startsWith(entry)) {
				return { category: 'whitelisted' };
			}
		}

		// 3. 未知
		return { category: 'unknown' };
	}
}
