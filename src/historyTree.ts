/**
 * 历史会话视图 - 侧边栏 TreeView，列出当前 workspace 的全部会话。
 * 支持单击打开会话（回放/继续对话共用）、右键删除、标题栏刷新；
 * 订阅会话数据变更（新建/追加/删除/重命名）自动刷新列表。
 */
import * as vscode from 'vscode';
import type { LocalSessionManager } from './core/localSessionManager';
import type { SessionMeta } from './memory/sessionFileStore';
import type { ChatViewProvider } from './chatPanel';
import * as logger from './logger';

/**
 * 会话树节点。
 * @param meta 会话元数据
 */
export class SessionItem extends vscode.TreeItem {
	constructor(readonly meta: SessionMeta) {
		super(meta.title || '新会话', vscode.TreeItemCollapsibleState.None);
		this.description = `${formatRelativeTime(meta.updatedAt)} · ${meta.messageCount} 条消息`;
		this.tooltip = [
			meta.title || '新会话',
			meta.sessionId,
			`创建于 ${meta.createdAt}`,
			`更新于 ${meta.updatedAt}`,
		].join('\n');
		this.contextValue = 'session';
		this.iconPath = new vscode.ThemeIcon('comment-discussion');
	}
}

/**
 * 历史会话树数据提供器。
 * @param sessionManager 会话管理器（提供列表与变更订阅）
 */
export class HistoryTreeProvider implements vscode.TreeDataProvider<SessionItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined | null | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly _disposables: vscode.Disposable[] = [];

	constructor(private readonly sessionManager: LocalSessionManager) {
		// 订阅会话数据变更（文件索引变更），自动刷新列表
		this._disposables.push({
			dispose: this.sessionManager.onDidChangeSessions(() => {
				logger.log('[HistoryTree] 会话数据变更，刷新历史视图');
				this._onDidChangeTreeData.fire();
			}),
		});
	}

	/** 释放订阅与事件发射器。 */
	dispose(): void {
		for (const d of this._disposables) {
			d.dispose();
		}
		this._onDidChangeTreeData.dispose();
	}

	/** 返回树节点（叶子节点无子项）。 */
	getTreeItem(element: SessionItem): vscode.TreeItem {
		return element;
	}

	/** 返回根级会话列表（按最近更新时间降序）。 */
	getChildren(_element?: SessionItem): SessionItem[] {
		if (_element) {
			return [];
		}
		return this.sessionManager.listSessions().map((meta) => new SessionItem(meta));
	}

	/** 手动刷新（标题栏按钮触发）。 */
	refresh(): void {
		this._onDidChangeTreeData.fire();
	}
}

/**
 * 注册历史视图相关命令（打开/删除/刷新）。
 * @param context 扩展上下文（注册到 subscriptions）
 * @param provider 历史视图 TreeDataProvider
 * @param sessionManager 会话管理器
 * @param chatProvider 对话面板（打开会话时切换并聚焦）
 */
export function registerHistoryCommands(
	context: vscode.ExtensionContext,
	provider: HistoryTreeProvider,
	sessionManager: LocalSessionManager,
	chatProvider: ChatViewProvider,
): void {
	// 单击/双击打开会话：先聚焦对话面板（确保 webview 就绪）再切换会话，避免消息丢失
	context.subscriptions.push(
		vscode.commands.registerCommand('yunxiaoAgent.history.open', async (item?: SessionItem) => {
			if (!item) {
				return;
			}
			logger.log(`[HistoryTree] 打开历史会话 sessionId=${item.meta.sessionId}`);
			await vscode.commands.executeCommand('yunxiaoAgent.chatView.focus');
			chatProvider.openSession(item.meta.sessionId);
		})
	);

	// 右键删除会话：确认后删除文件与索引
	context.subscriptions.push(
		vscode.commands.registerCommand('yunxiaoAgent.history.delete', async (item?: SessionItem) => {
			if (!item) {
				return;
			}
			const title = item.meta.title || '新会话';
			const confirm = await vscode.window.showWarningMessage(
				`确定删除会话「${title}」？该操作不可恢复。`,
				{ modal: true },
				'删除'
			);
			if (confirm === '删除') {
				sessionManager.deleteSession(item.meta.sessionId);
			}
		})
	);

	// 标题栏刷新按钮
	context.subscriptions.push(
		vscode.commands.registerCommand('yunxiaoAgent.history.refresh', () => {
			provider.refresh();
		})
	);
}

/**
 * 将 ISO 时间格式化为相对时间（刚刚/x 分钟前/x 小时前/x 天前/日期）。
 * @param iso ISO 时间字符串
 * @returns 相对时间文本
 */
function formatRelativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	const diff = Date.now() - then;
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (diff < minute) {
		return '刚刚';
	}
	if (diff < hour) {
		return `${Math.floor(diff / minute)} 分钟前`;
	}
	if (diff < day) {
		return `${Math.floor(diff / hour)} 小时前`;
	}
	if (diff < 30 * day) {
		return `${Math.floor(diff / day)} 天前`;
	}
	return new Date(iso).toLocaleDateString();
}
