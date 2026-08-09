/**
 * 审批网关 - 写/执行/破坏性工具执行前的用户确认闸门。
 *
 * 三选项：「允许」（记入会话级内存，本 session 内同工具不再弹窗）、
 * 「始终允许」（写入 yunxiaoAgent.alwaysAllowTools 配置，跨 session 持久）、
 * 「拒绝」（回传 cancelled，不执行）。
 * 只读（read）工具免审批（由路由层 shouldGate 判定）。
 *
 * 设计：prompter 与 configStore 可注入，使核心逻辑无需真实 vscode 即可单测。
 * 本地以工具自身 permission 为准强制审批，不信任云端 require_approval 标志（防御纵深）。
 */
import type { Permission } from './types';
import * as logger from '../logger';

/** 审批决策。 */
export type ApprovalDecision = 'allow' | 'always' | 'deny';

/** 可注入的提示器：展示审批弹窗并返回用户选择（关闭/拒绝返回 undefined）。 */
export interface ApprovalPromptContext {
	readonly toolName: string;
	readonly summary: string;
	readonly sessionId?: string;
	readonly callId?: string;
}

/** 本地审批范围：所有字段均由插件本地上下文生成，不信任云端输入。 */
export interface ApprovalScope {
	readonly workspaceId: string;
	readonly resourcePattern: string;
	readonly commandPattern?: string;
	readonly expiresAt?: string;
	readonly policyVersion?: number;
}

/** 持久化范围授权记录。 */
export interface ScopedApproval extends ApprovalScope {
	readonly toolName: string;
	readonly expiresAt: string;
	readonly policyVersion: number;
}

export interface ApprovalPrompter {
	prompt(ctx: ApprovalPromptContext): Promise<ApprovalDecision | undefined>;
}

/** 可注入的配置存储：读写 alwaysAllowTools 持久允许列表。 */
export interface ApprovalConfigStore {
	getAlwaysAllow(): string[];
	addAlwaysAllow(name: string): Promise<void>;
	getScopedApprovals?(): ScopedApproval[];
	addScopedApproval?(approval: ScopedApproval): Promise<void>;
}

/** ApprovalGateway 构造选项。 */
export interface ApprovalGatewayOptions {
	readonly prompter?: ApprovalPrompter;
	readonly store?: ApprovalConfigStore;
}

type VsCodeApi = typeof import('vscode');
function vscodeApi(): VsCodeApi {
	return require('vscode');
}

const CONFIG_SECTION = 'yunxiaoAgent';
const CONFIG_KEY = 'alwaysAllowTools';
const SCOPED_CONFIG_KEY = 'scopedApprovals';
const POLICY_VERSION = 1;
const GRANT_DURATION_MS = 24 * 60 * 60 * 1000;

/** 默认提示器：用 vscode.window.showWarningMessage 三按钮。 */
const defaultPrompter: ApprovalPrompter = {
	async prompt(ctx: ApprovalPromptContext): Promise<ApprovalDecision | undefined> {
		const choice = await vscodeApi().window.showWarningMessage(
			ctx.summary,
			{ modal: false },
			'允许',
			'始终允许',
			'拒绝'
		);
		if (choice === '允许') {
			return 'allow';
		}
		if (choice === '始终允许') {
			return 'always';
		}
		return undefined; // 「拒绝」或关闭弹窗
	},
};

/** 默认配置存储：读写 yunxiaoAgent.alwaysAllowTools。 */
const defaultStore: ApprovalConfigStore = {
	getAlwaysAllow(): string[] {
		return vscodeApi().workspace
			.getConfiguration(CONFIG_SECTION)
			.get<string[]>(CONFIG_KEY, []);
	},
	async addAlwaysAllow(name: string): Promise<void> {
		const cfg = vscodeApi().workspace.getConfiguration(CONFIG_SECTION);
		const current = cfg.get<string[]>(CONFIG_KEY, []);
		if (!current.includes(name)) {
			await cfg.update(
				CONFIG_KEY,
				[...current, name],
				vscodeApi().ConfigurationTarget.Global
			);
		}
	},
	getScopedApprovals(): ScopedApproval[] {
		return vscodeApi().workspace.getConfiguration(CONFIG_SECTION)
			.get<ScopedApproval[]>(SCOPED_CONFIG_KEY, []);
	},
	async addScopedApproval(approval: ScopedApproval): Promise<void> {
		const cfg = vscodeApi().workspace.getConfiguration(CONFIG_SECTION);
		const current = cfg.get<ScopedApproval[]>(SCOPED_CONFIG_KEY, []);
		const filtered = current.filter((entry) => !sameScope(entry, approval));
		await cfg.update(SCOPED_CONFIG_KEY, [...filtered, approval], vscodeApi().ConfigurationTarget.Workspace);
	},
};

export class ApprovalGateway {
	private readonly sessionAllow = new Map<string, Set<string>>();
	private readonly prompter: ApprovalPrompter;
	private readonly store: ApprovalConfigStore;

	constructor(opts?: ApprovalGatewayOptions) {
		this.prompter = opts?.prompter ?? defaultPrompter;
		this.store = opts?.store ?? defaultStore;
	}

	/** read 权限免审批，其余（write/execute/destructive）需审批。 */
	shouldGate(permission: Permission): boolean {
		return permission !== 'read';
	}

	/**
	 * 请求审批。命中持久/会话允许则直通；否则弹窗。
	 * @returns 'allow' | 'always' 表示放行，'deny' 表示拒绝。
	 */
	async requestApproval(
		toolName: string,
		summary: string,
		sessionId?: string,
		callId?: string,
		scope: ApprovalScope = defaultScope()
	): Promise<ApprovalDecision> {
		const normalizedScope = normalizeScope(scope);
		logger.log('[ApprovalGateway] 发起审批请求 toolName=' + toolName + ' sessionId=' + (sessionId ?? 'none') + ' callId=' + (callId ?? 'none'));
		// 1. 持久允许（配置）
		if (this.matchesScopedApproval(toolName, normalizedScope)) {
			return 'allow';
		}
		// 兼容历史配置：只读，不再写入该宽泛设置。
		if (this.store.getAlwaysAllow().includes(toolName)) {
			return 'allow';
		}
		// 2. 会话级允许（内存）
		if (sessionId && this.sessionAllow.get(sessionId)?.has(scopeKey(toolName, normalizedScope))) {
			return 'allow';
		}
		// 3. 弹窗
		const decision = await this.prompter.prompt({ toolName, summary, sessionId, callId });
		logger.log('[ApprovalGateway] 审批结果 decision=' + (decision ?? 'closed') + ' toolName=' + toolName + ' sessionId=' + (sessionId ?? 'none'));
		if (decision === 'allow') {
			if (sessionId) {
				let set = this.sessionAllow.get(sessionId);
				if (!set) {
					set = new Set();
					this.sessionAllow.set(sessionId, set);
				}
				set.add(scopeKey(toolName, normalizedScope));
			}
			return 'allow';
		}
		if (decision === 'always') {
			await this.addScopedApproval(toolName, normalizedScope);
			return 'always';
		}
		return 'deny';
	}

	/** destructive 操作在普通审批后要求一次不受会话/持久允许影响的二次确认。 */
	async requestDestructiveApproval(
		toolName: string,
		summary: string,
		sessionId?: string,
		callId?: string,
		scope?: ApprovalScope
	): Promise<ApprovalDecision> {
		const first = await this.requestApproval(toolName, summary, sessionId, callId, scope);
		if (first === 'deny') {
			return 'deny';
		}
		const confirm = await this.prompter.prompt({
			toolName,
			summary: `二次确认：此操作具有破坏性，执行后可能无法恢复。\n${summary}`,
			sessionId,
			callId,
		});
		return confirm === 'allow' || confirm === 'always' ? 'allow' : 'deny';
	}

	/** 清理会话级允许记忆（会话重置时调用）。 */
	clearSession(sessionId: string): void {
		this.sessionAllow.delete(sessionId);
	}

	private matchesScopedApproval(toolName: string, scope: ApprovalScope): boolean {
		return (this.store.getScopedApprovals?.() ?? []).some((approval) =>
			approval.toolName === toolName &&
			approval.policyVersion === POLICY_VERSION &&
			Date.parse(approval.expiresAt) > Date.now() &&
			sameScope(normalizeScope(approval), scope)
		);
	}

	private async addScopedApproval(toolName: string, scope: ApprovalScope): Promise<void> {
		const approval: ScopedApproval = {
			...scope,
			toolName,
			expiresAt: new Date(Date.now() + GRANT_DURATION_MS).toISOString(),
			policyVersion: POLICY_VERSION,
		};
		if (this.store.addScopedApproval) {
			await this.store.addScopedApproval(approval);
			return;
		}
		await this.store.addAlwaysAllow(toolName);
	}
}

/** 规范化本地范围，避免路径分隔符和大小写造成错误复用。 */
function normalizeScope(scope: ApprovalScope): ApprovalScope {
	return {
		workspaceId: scope.workspaceId.replace(/\\/g, '/').toLowerCase(),
		resourcePattern: scope.resourcePattern.replace(/\\/g, '/').toLowerCase(),
		commandPattern: scope.commandPattern?.trim().replace(/\s+/g, ' '),
	};
}

function defaultScope(): ApprovalScope {
	return { workspaceId: 'unknown-workspace', resourcePattern: '*' };
}

function scopeKey(toolName: string, scope: ApprovalScope): string {
	return `${toolName}:${scope.workspaceId}:${scope.resourcePattern}:${scope.commandPattern ?? ''}`;
}

function sameScope(left: ApprovalScope, right: ApprovalScope): boolean {
	return left.workspaceId === right.workspaceId &&
		left.resourcePattern === right.resourcePattern &&
		left.commandPattern === right.commandPattern;
}
