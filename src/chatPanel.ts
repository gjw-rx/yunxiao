import * as vscode from 'vscode';
import * as path from 'path';
import { AIClient } from './aiClient';
import type { ToolRegistry } from './core/toolRegistry';
import type { SessionManager } from './core/sessionManager';
import type { EventBus, AgentEvent } from './core/eventBus';

interface ChatViewDeps {
	readonly client: AIClient;
	readonly registry: ToolRegistry;
	readonly sessionManager: SessionManager;
	readonly eventBus: EventBus;
}

function getServiceBaseUrl(): string {
	return vscode.workspace
		.getConfiguration('yunxiaoAgent')
		.get<string>('serviceBaseUrl', 'http://127.0.0.1:8002');
}

function friendlyError(err: unknown, baseUrl: string): string {
	const message = err instanceof Error ? err.message : String(err);
	if (
		message.includes('ECONNREFUSED') ||
		message.includes('ENOTFOUND') ||
		message.includes('fetch failed') ||
		message.includes('connect')
	) {
		return `无法连接 AI 服务，请确认服务已启动且地址正确（当前: ${baseUrl}）`;
	}
	if (message.includes('会话不存在')) {
		return '会话已失效，请新建会话';
	}
	return message;
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let i = 0; i < 32; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}

/** 待处理的审批请求：call_id -> resolve 回调 */
type ApprovalResolver = (decision: 'allow' | 'always' | 'deny') => void;

export class ChatViewProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private readonly _client: AIClient;
	private readonly _registry: ToolRegistry;
	private readonly _sessionManager: SessionManager;
	private readonly _eventBus: EventBus;
	private _baseUrl: string;
	private _configListener?: vscode.Disposable;
	private _currentSessionId?: string;
	private readonly _pendingApprovals = new Map<string, ApprovalResolver>();

	constructor(
		private readonly _context: vscode.ExtensionContext,
		deps: ChatViewDeps
	) {
		this._baseUrl = getServiceBaseUrl();
		this._client = deps.client;
		this._registry = deps.registry;
		this._sessionManager = deps.sessionManager;
		this._eventBus = deps.eventBus;
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_ctx: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.file(path.join(this._context.extensionPath, 'dist')),
				vscode.Uri.file(path.join(this._context.extensionPath, 'media')),
			],
		};

		webviewView.webview.html = this._getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(
			async (msg: { command: string; [key: string]: unknown }) => {
				await this._handleMessage(msg);
			},
			undefined,
			this._context.subscriptions
		);

		this._configListener = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('yunxiaoAgent.serviceBaseUrl')) {
				const newUrl = getServiceBaseUrl();
				if (newUrl !== this._baseUrl) {
					this._baseUrl = newUrl;
					vscode.window.showInformationMessage(
						`云效 Agent: 服务地址已更新为 ${this._baseUrl}，请重新加载窗口以生效`
					);
				}
			}
		});

		this._context.subscriptions.push(this._configListener);

		// 订阅事件总线，将当前会话的事件转发给 webview
		const unsub = this._eventBus.onAll((e) => this._forwardEvent(e));
		this._context.subscriptions.push({ dispose: unsub });
	}

	/** 将当前会话的事件总线事件转发给 webview。 */
	private _forwardEvent(e: AgentEvent): void {
		const view = this._view;
		if (!view || e.sessionId !== this._currentSessionId) {
			return;
		}
		switch (e.type) {
			case 'content':
				view.webview.postMessage({ command: 'replyChunk', text: e.payload as string });
				break;
			case 'stream_end':
				view.webview.postMessage({ command: 'replyEnd' });
				break;
			case 'error':
				view.webview.postMessage({ command: 'error', message: e.payload as string });
				break;
			case 'tool_state_change': {
				const p = e.payload as { call_id: string; state: string; tool: string; error?: string; input?: unknown; output?: unknown };
				view.webview.postMessage({ command: 'toolState', ...p });
				break;
			}
			case 'thought':
				view.webview.postMessage({ command: 'thought', text: e.payload as string });
				break;
			case 'plan': {
				const p = e.payload as { steps: string[] };
				view.webview.postMessage({ command: 'plan', steps: p.steps });
				break;
			}
			default:
				break;
		}
	}

	/** 从工具栏"新建会话"按钮触发 */
	triggerNewSession(): void {
		this._view?.webview.postMessage({ command: 'triggerNewSession' });
	}

	/**
	 * 通过 webview 内嵌卡片请求用户审批。
	 * 返回 Promise，用户点击按钮后 resolve。
	 * @param callId 工具调用 ID（用于关联审批结果）
	 * @param toolName 工具名称
	 * @param summary 操作摘要
	 * @param filePath 关联的文件路径（可选）
	 * @param sessionId 当前会话 ID
	 */
	requestApproval(
		callId: string,
		toolName: string,
		summary: string,
		filePath: string | undefined,
		sessionId: string
	): Promise<'allow' | 'always' | 'deny'> {
		const view = this._view;
		return new Promise<'allow' | 'always' | 'deny'>((resolve) => {
			if (!view || sessionId !== this._currentSessionId) {
				// 视图不可见或会话不匹配，回退为 deny（安全保守）
				resolve('deny');
				return;
			}
			this._pendingApprovals.set(callId, resolve);
			view.webview.postMessage({
				command: 'approvalRequest',
				call_id: callId,
				tool_name: toolName,
				summary,
				file_path: filePath,
			});
		});
	}

	private async _handleMessage(msg: { command: string; [key: string]: unknown }): Promise<void> {
		const view = this._view;
		if (!view) { return; }

		switch (msg.command) {
			case 'requestAgents': {
				try {
					const agents = await this._client.listAgents();
					view.webview.postMessage({ command: 'agentsLoaded', agents });
				} catch (err: unknown) {
					view.webview.postMessage({
						command: 'error',
						message: `获取 Agent 列表失败: ${friendlyError(err, this._baseUrl)}`,
					});
				}
				break;
			}
			case 'createSession': {
				try {
					// 重置旧会话状态
					if (this._currentSessionId) {
						this._sessionManager.reset(this._currentSessionId);
					}
					const result = await this._client.createSession(
						msg.agentId as string,
						this._registry.localSchemas()
					);
					this._currentSessionId = result.session_id;
					view.webview.postMessage({ command: 'sessionCreated', sessionId: result.session_id });
				} catch (err: unknown) {
					view.webview.postMessage({
						command: 'error',
						message: `创建会话失败: ${friendlyError(err, this._baseUrl)}`,
					});
				}
				break;
			}
			case 'sendMessage': {
				const sessionId = msg.sessionId as string;
				const text = msg.text as string;
				// 经会话状态机发起流；事件经事件总线回流（见 _forwardEvent）
				this._sessionManager.sendMessage(sessionId, text);
				break;
			}
			case 'stopStream': {
				const sessionId = msg.sessionId as string;
				this._sessionManager.cancel(sessionId);
				break;
			}
			case 'loadHistory': {
				try {
					const history = await this._client.getHistory(msg.sessionId as string);
					view.webview.postMessage({ command: 'historyLoaded', messages: history });
				} catch (err: unknown) {
					view.webview.postMessage({
						command: 'error',
						message: `加载历史失败: ${friendlyError(err, this._baseUrl)}`,
					});
				}
				break;
			}
			case 'approvalDecision': {
				const callId = msg.call_id as string;
				const decision = msg.decision as 'allow' | 'always' | 'deny';
				const resolver = this._pendingApprovals.get(callId);
				if (resolver) {
					this._pendingApprovals.delete(callId);
					resolver(decision);
				}
				break;
			}
			case 'openDiff': {
				const filePath = msg.file_path as string;
				if (filePath) {
					vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
				}
				break;
			}
		}
	}

	private _getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const markedUri = webview.asWebviewUri(
			vscode.Uri.file(path.join(this._context.extensionPath, 'dist', 'webview', 'marked.js'))
		);

		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource};">
  <title>云效 Agent</title>
  <style>
${this._getCss()}
  </style>
</head>
<body>
${this._getBodyHtml()}
  <script nonce="${nonce}" src="${markedUri}"></script>
  <script nonce="${nonce}">
${this._getJs()}
  </script>
</body>
</html>`;
	}

	private _getCss(): string {
		return `
    /* ── Design tokens ── */
    :root {
      --bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e));
      --fg: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground, #cccccc));
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --input-border: var(--vscode-input-border, transparent);
      --input-placeholder: var(--vscode-input-placeholderForeground, rgba(128,128,128,0.6));
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --btn-secondary-bg: var(--vscode-button-secondaryBackground, var(--vscode-input-background, #3c3c3c));
      --btn-secondary-fg: var(--vscode-button-secondaryForeground, var(--vscode-input-foreground, #cccccc));
      --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      --font-size: var(--vscode-font-size, 13px);
      --mono: var(--vscode-editor-font-family, 'SF Mono', Monaco, Menlo, Consolas, monospace);
      --border: var(--vscode-panel-border, rgba(128,128,128,0.2));
      --border-light: var(--vscode-widget-border, rgba(128,128,128,0.1));
      --radius: 6px;
      --radius-lg: 8px;
      --accent: var(--vscode-textLink-foreground, #3794ff);
      --success: var(--vscode-testing-iconPassed, #3fb950);
      --error: var(--vscode-errorForeground, #f85149);
      --warning: var(--vscode-editorWarning-foreground, #d29922);
      --muted: var(--vscode-descriptionForeground, rgba(128,128,128,0.6));
      --hover-bg: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15));
      --focus: var(--vscode-focusBorder, #007fd4);
      --code-bg: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.12));
      --diff-add-bg: var(--vscode-diffEditor-insertedTextBackground, rgba(46,160,67,0.15));
      --diff-del-bg: var(--vscode-diffEditor-removedTextBackground, rgba(248,81,73,0.15));
      --diff-add-line: var(--vscode-diffEditor-insertedLineBackground, rgba(46,160,67,0.1));
      --diff-del-line: var(--vscode-diffEditor-removedLineBackground, rgba(248,81,73,0.1));
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      height: 100%;
      width: 100%;
      overflow: hidden;
    }

    body {
      font-family: var(--font);
      font-size: var(--font-size);
      color: var(--fg);
      background: var(--bg);
      display: flex;
      flex-direction: column;
      line-height: 1.5;
    }

    /* ── Scrollbar ── */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: rgba(128,128,128,0.25);
      border-radius: 3px;
    }
    ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.4); }

    /* ── Header ── */
    #header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      position: relative;
    }

    /* ── Agent selector (custom dropdown) ── */
    #agentSelector {
      flex: 1;
      min-width: 0;
      position: relative;
    }

    #agentBtn {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: var(--radius);
      cursor: pointer;
      font-family: var(--font);
      font-size: 12px;
      text-align: left;
      transition: border-color 0.15s;
    }
    #agentBtn:hover { border-color: var(--muted); }
    #agentBtn:focus { outline: none; border-color: var(--focus); }
    #agentBtn.open { border-color: var(--focus); }

    .agent-icon-dot {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 11px;
      font-weight: 600;
      color: #fff;
    }

    .agent-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .agent-name {
      font-weight: 500;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .agent-model {
      font-size: 10px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .chevron {
      width: 12px;
      height: 12px;
      flex-shrink: 0;
      transition: transform 0.2s;
      color: var(--muted);
    }
    #agentBtn.open .chevron { transform: rotate(180deg); }

    /* Dropdown panel */
    #agentDropdown {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      background: var(--vscode-dropdown-background, var(--vscode-editor-background, #252526));
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 100;
      max-height: 280px;
      overflow-y: auto;
      display: none;
    }
    #agentDropdown.show { display: block; }

    .agent-card {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      cursor: pointer;
      transition: background 0.12s;
      border-bottom: 1px solid var(--border-light);
    }
    .agent-card:last-child { border-bottom: none; }
    .agent-card:hover { background: var(--hover-bg); }
    .agent-card.selected {
      background: var(--vscode-list-activeSelectionBackground, rgba(14,99,156,0.3));
    }

    .agent-card .agent-icon-dot { width: 28px; height: 28px; font-size: 12px; }
    .agent-card .agent-info .agent-name { font-size: 13px; }
    .agent-card .agent-info .agent-model { font-size: 11px; }

    .agent-card-desc {
      font-size: 11px;
      color: var(--muted);
      margin-top: 2px;
      line-height: 1.4;
    }

    /* ── Buttons ── */
    .btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 5px 10px;
      border-radius: var(--radius);
      cursor: pointer;
      font-family: var(--font);
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      transition: background 0.12s, opacity 0.12s;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
    }
    .btn:hover:not(:disabled) { background: var(--btn-hover); }
    .btn:active:not(:disabled) { transform: scale(0.97); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .btn-icon {
      padding: 5px;
      background: transparent;
      color: var(--fg);
      border-radius: var(--radius);
    }
    .btn-icon:hover:not(:disabled) { background: var(--hover-bg); }

    .btn-stop {
      padding: 4px 8px;
      background: var(--vscode-inputValidation-errorBackground, #c72e2e);
      color: #fff;
    }
    .btn-stop:hover:not(:disabled) { opacity: 0.85; }

    /* ── Tool calls section ── */
    #toolsSection {
      flex-shrink: 0;
      border-bottom: 1px solid var(--border);
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s ease;
    }
    #toolsSection.active {
      max-height: 300px;
    }

    #toolsHeader {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      cursor: pointer;
      user-select: none;
      background: var(--vscode-sideBarSectionHeader-background, transparent);
    }
    #toolsHeader:hover { background: var(--hover-bg); }

    #toolsHeader .chevron { transition: transform 0.2s; }
    #toolsSection.collapsed #toolsHeader .chevron { transform: rotate(-90deg); }

    #toolsTitle {
      flex: 1;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
    }

    #toolsCount {
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 10px;
      min-width: 18px;
      text-align: center;
    }

    #toolsList {
      overflow-y: auto;
      max-height: 240px;
      padding: 2px 8px 8px;
    }
    #toolsSection.collapsed #toolsList { display: none; }

    .tool-chip {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: var(--radius);
      margin-bottom: 3px;
      background: var(--code-bg);
      border: 1px solid var(--border-light);
      cursor: pointer;
      transition: background 0.12s;
    }
    .tool-chip:hover { background: var(--hover-bg); }

    .tool-icon {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .tool-icon svg { width: 14px; height: 14px; }

    .tool-chip-name {
      flex: 1;
      font-size: 12px;
      font-family: var(--mono);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .tool-chip-status {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      flex-shrink: 0;
    }

    .tool-status-icon {
      width: 14px;
      height: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .tool-chip.pending .tool-status-icon { color: var(--muted); }
    .tool-chip.running .tool-status-icon { color: var(--accent); }
    .tool-chip.success .tool-status-icon { color: var(--success); }
    .tool-chip.error .tool-status-icon { color: var(--error); }

    /* Spinner */
    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid transparent;
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Tool detail expanded */
    .tool-detail {
      display: none;
      padding: 8px 10px;
      margin: 2px 0 4px;
      background: var(--vscode-editor-background, #1e1e1e);
      border-radius: var(--radius);
      border: 1px solid var(--border-light);
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.5;
      max-height: 180px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .tool-chip.expanded + .tool-detail { display: block; }

    .tool-detail-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 4px;
      font-family: var(--font);
    }
    .tool-detail-section { margin-bottom: 8px; }
    .tool-detail-section:last-child { margin-bottom: 0; }

    /* ── Messages area ── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px 10px 4px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .placeholder {
      text-align: center;
      color: var(--muted);
      margin: auto;
      font-size: 12px;
      line-height: 1.7;
      padding: 30px 10px;
    }
    .placeholder svg { opacity: 0.35; margin-bottom: 10px; }
    .placeholder-title {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 4px;
      color: var(--fg);
      opacity: 0.7;
    }

    .msg-row {
      display: flex;
      flex-direction: column;
      max-width: 100%;
      margin-bottom: 10px;
    }

    .msg-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 4px;
      padding: 0 2px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .message {
      line-height: 1.6;
      font-size: 13px;
      word-break: break-word;
    }

    .message.user {
      align-self: flex-end;
      background: var(--vscode-badge-background, var(--btn-bg));
      color: var(--vscode-badge-foreground, var(--btn-fg));
      padding: 8px 12px;
      border-radius: 12px 12px 2px 12px;
      white-space: pre-wrap;
      max-width: 88%;
    }

    .message.assistant {
      align-self: flex-start;
      padding: 2px 2px;
      max-width: 100%;
    }

    /* Markdown styling */
    .message.assistant p { margin: 0 0 8px; }
    .message.assistant p:last-child { margin-bottom: 0; }
    .message.assistant pre {
      background: var(--code-bg);
      padding: 10px 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 6px 0;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.5;
      border: 1px solid var(--border-light);
    }
    .message.assistant code {
      font-family: var(--mono);
      font-size: 0.88em;
      background: var(--code-bg);
      padding: 1px 5px;
      border-radius: 3px;
    }
    .message.assistant pre code { background: none; padding: 0; }
    .message.assistant ul,
    .message.assistant ol { padding-left: 20px; margin: 6px 0; }
    .message.assistant li { margin: 2px 0; }
    .message.assistant a { color: var(--accent); text-decoration: none; }
    .message.assistant a:hover { text-decoration: underline; }
    .message.assistant blockquote {
      border-left: 3px solid var(--vscode-textBlockQuote-border, rgba(128,128,128,0.4));
      padding-left: 12px;
      margin: 6px 0;
      opacity: 0.8;
    }
    .message.assistant h1,
    .message.assistant h2,
    .message.assistant h3 { margin: 10px 0 6px; font-size: 1em; font-weight: 600; }
    .message.assistant h1 { font-size: 1.2em; }
    .message.assistant h2 { font-size: 1.1em; }
    .message.assistant table {
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 12px;
      width: 100%;
    }
    .message.assistant th,
    .message.assistant td {
      border: 1px solid var(--border);
      padding: 5px 10px;
    }
    .message.assistant th {
      background: var(--code-bg);
      font-weight: 600;
    }

    /* streaming cursor */
    .cursor::after {
      content: '▋';
      animation: blink 0.9s step-start infinite;
      opacity: 0.7;
      margin-left: 1px;
    }
    @keyframes blink { 50% { opacity: 0; } }

    /* Thought / plan */
    .message.thought {
      font-style: italic;
      opacity: 0.65;
      font-size: 12px;
      align-self: flex-start;
      padding: 4px 8px;
      border-left: 2px solid var(--muted);
      margin-left: 2px;
    }
    .message.plan {
      align-self: flex-start;
      font-size: 12px;
      padding: 6px 10px;
      background: var(--code-bg);
      border-radius: var(--radius);
      border: 1px solid var(--border-light);
      margin-left: 2px;
    }
    .message.plan ol { padding-left: 20px; margin: 0; }
    .message.plan li { margin: 2px 0; }

    /* ── Approval card ── */
    .approval-card {
      background: var(--vscode-inputValidation-warningBackground, rgba(210,153,34,0.08));
      border: 1px solid var(--warning);
      border-radius: var(--radius-lg);
      padding: 12px;
      margin: 8px 0;
    }

    .approval-header {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-bottom: 10px;
    }

    .approval-icon {
      width: 20px;
      height: 20px;
      flex-shrink: 0;
      color: var(--warning);
      margin-top: 1px;
    }

    .approval-content { flex: 1; min-width: 0; }

    .approval-tool-name {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .approval-summary {
      font-size: 12px;
      color: var(--fg);
      line-height: 1.5;
      margin-bottom: 4px;
    }

    .approval-file-path {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--accent);
      background: var(--code-bg);
      padding: 3px 6px;
      border-radius: 3px;
      display: inline-block;
      word-break: break-all;
    }

    .approval-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .approval-btn {
      padding: 5px 12px;
      border-radius: var(--radius);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      font-family: var(--font);
      transition: background 0.12s, border-color 0.12s;
    }

    .approval-btn.allow {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border-color: var(--btn-bg);
    }
    .approval-btn.allow:hover { background: var(--btn-hover); }

    .approval-btn.always {
      background: transparent;
      color: var(--btn-bg);
      border-color: var(--btn-bg);
    }
    .approval-btn.always:hover { background: rgba(14,99,156,0.1); }

    .approval-btn.deny {
      background: transparent;
      color: var(--error);
      border-color: var(--error);
    }
    .approval-btn.deny:hover { background: rgba(248,81,73,0.1); }

    /* ── Diff card ── */
    .diff-card {
      background: var(--code-bg);
      border: 1px solid var(--border-light);
      border-radius: var(--radius-lg);
      margin: 8px 0;
      overflow: hidden;
    }

    .diff-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
      transition: background 0.12s;
      background: var(--vscode-editor-background, #1e1e1e);
    }
    .diff-header:hover { background: var(--hover-bg); }

    .diff-icon {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      color: var(--accent);
    }

    .diff-filename {
      flex: 1;
      font-family: var(--mono);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .diff-stats {
      display: flex;
      gap: 8px;
      font-size: 11px;
      font-family: var(--mono);
      flex-shrink: 0;
    }
    .diff-additions { color: var(--success); }
    .diff-deletions { color: var(--error); }

    .diff-chevron {
      width: 12px;
      height: 12px;
      flex-shrink: 0;
      transition: transform 0.2s;
      color: var(--muted);
    }
    .diff-card.expanded .diff-chevron { transform: rotate(180deg); }

    .diff-body {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s ease;
    }
    .diff-card.expanded .diff-body {
      max-height: 500px;
    }

    .diff-content {
      padding: 0;
      overflow-x: auto;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.5;
      border-top: 1px solid var(--border-light);
    }

    .diff-table {
      width: 100%;
      border-collapse: collapse;
    }
    .diff-table td {
      padding: 1px 8px;
      white-space: pre;
      vertical-align: top;
    }
    .diff-line-num {
      width: 36px;
      text-align: right;
      color: var(--muted);
      user-select: none;
      background: var(--vscode-editorGutter-background, transparent);
      font-size: 10px;
    }
    .diff-line-content { padding-left: 8px; }

    .diff-add { background: var(--diff-add-line); }
    .diff-add .diff-line-content { background: var(--diff-add-bg); }
    .diff-del { background: var(--diff-del-line); }
    .diff-del .diff-line-content { background: var(--diff-del-bg); }
    .diff-ctx { color: var(--muted); }

    .diff-footer {
      padding: 6px 10px;
      border-top: 1px solid var(--border-light);
      background: var(--vscode-editor-background, #1e1e1e);
    }
    .diff-footer a {
      color: var(--accent);
      font-size: 11px;
      text-decoration: none;
      cursor: pointer;
    }
    .diff-footer a:hover { text-decoration: underline; }

    /* ── Error bar ── */
    #error {
      padding: 6px 10px;
      color: var(--error);
      font-size: 11px;
      flex-shrink: 0;
      border-top: 1px solid transparent;
      background: var(--vscode-inputValidation-errorBackground, transparent);
    }
    #error:not(:empty) { border-color: var(--border); }
    #error:empty { display: none; }

    /* ── Input area ── */
    #inputArea {
      padding: 8px 10px 10px;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
      background: var(--bg);
    }

    #inputWrapper {
      display: flex;
      align-items: flex-end;
      gap: 6px;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 10px;
      padding: 6px 8px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    #inputWrapper:focus-within {
      border-color: var(--focus);
      box-shadow: 0 0 0 1px var(--focus);
    }

    #input {
      flex: 1;
      background: transparent;
      color: var(--input-fg);
      border: none;
      padding: 3px 0;
      font-family: var(--font);
      font-size: 13px;
      line-height: 1.5;
      resize: none;
      min-height: 22px;
      max-height: 120px;
      outline: none;
    }
    #input::placeholder { color: var(--input-placeholder); }
    #input:disabled { cursor: not-allowed; opacity: 0.5; }

    #sendBtn, #stopBtn {
      width: 28px;
      height: 28px;
      padding: 0;
      border-radius: 6px;
      flex-shrink: 0;
    }

    #hint {
      text-align: center;
      font-size: 10px;
      color: var(--muted);
      margin-top: 5px;
      opacity: 0.7;
    }
`;
	}

	private _getBodyHtml(): string {
		return `
  <div id="header">
    <div id="agentSelector">
      <button id="agentBtn" aria-haspopup="listbox">
        <span class="agent-icon-dot" id="agentIcon" style="background: #6c757d;">?</span>
        <span class="agent-info">
          <span class="agent-name" id="agentName">选择 Agent</span>
          <span class="agent-model" id="agentModelText">--</span>
        </span>
        <svg class="chevron" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 6l4 4 4-4H4z"/>
        </svg>
      </button>
      <div id="agentDropdown" role="listbox"></div>
    </div>
    <button id="newSessionBtn" class="btn" title="新建会话">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm1 10H7V9H5V7h2V5h2v2h2v2H9v2z"/>
      </svg>
      新会话
    </button>
  </div>

  <div id="toolsSection" class="collapsed">
    <div id="toolsHeader">
      <svg class="chevron" viewBox="0 0 16 16" fill="currentColor" style="width:12px;height:12px;">
        <path d="M4 6l4 4 4-4H4z"/>
      </svg>
      <span id="toolsTitle">工具调用</span>
      <span id="toolsCount">0</span>
    </div>
    <div id="toolsList"></div>
  </div>

  <div id="messages">
    <div class="placeholder">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor" style="display:block;margin:0 auto 10px;">
        <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/>
      </svg>
      <div class="placeholder-title">欢迎使用云效 Agent</div>
      选择 Agent 并点击「新会话」开始对话
    </div>
  </div>

  <div id="error"></div>

  <div id="inputArea">
    <div id="inputWrapper">
      <textarea id="input" rows="1" placeholder="输入消息..." disabled></textarea>
      <button id="sendBtn" class="btn" disabled title="发送 (Enter)">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 1.5l13 6.5-13 6.5V8.75l8-1.25-8-1.25V1.5z"/>
        </svg>
      </button>
      <button id="stopBtn" class="btn btn-stop" style="display:none" title="停止">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <rect x="1" y="1" width="8" height="8" rx="1"/>
        </svg>
      </button>
    </div>
    <div id="hint">Enter 发送 &middot; Shift+Enter 换行</div>
  </div>
`;
	}

	private _getJs(): string {
		return `
    const vscode = acquireVsCodeApi();

    // ── DOM refs ──
    const messagesEl   = document.getElementById('messages');
    const inputEl      = document.getElementById('input');
    const sendBtn      = document.getElementById('sendBtn');
    const stopBtn      = document.getElementById('stopBtn');
    const newSessBtn   = document.getElementById('newSessionBtn');
    const errorEl      = document.getElementById('error');
    const agentBtn     = document.getElementById('agentBtn');
    const agentDropdown= document.getElementById('agentDropdown');
    const agentIcon    = document.getElementById('agentIcon');
    const agentName    = document.getElementById('agentName');
    const agentModelText = document.getElementById('agentModelText');
    const toolsSection = document.getElementById('toolsSection');
    const toolsHeader  = document.getElementById('toolsHeader');
    const toolsList    = document.getElementById('toolsList');
    const toolsCount   = document.getElementById('toolsCount');

    // ── State ──
    let agents = [];
    let selectedAgentId = null;
    let currentSessionId = null;
    let isStreaming = false;
    let currentAssistantEl = null;
    let currentAssistantTxt = '';
    const toolEntries = new Map(); // call_id -> { chipEl, detailEl, state, tool }
    const approvalCards = new Map(); // call_id -> card element
    const diffCards = new Map(); // call_id -> card element
    let toolsExpanded = false;

    // ── Color palette for agent icons ──
    const agentColors = [
      '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3',
      '#03a9f4', '#00bcd4', '#009688', '#4caf50', '#8bc34a',
      '#cddc39', '#ffc107', '#ff9800', '#ff5722', '#795548',
      '#607d8b', '#f44336', '#e91e63'
    ];

    function getAgentColor(id, name) {
      let hash = 0;
      const str = id + name;
      for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
      }
      return agentColors[Math.abs(hash) % agentColors.length];
    }

    function getAgentInitial(name) {
      return name ? name.charAt(0).toUpperCase() : '?';
    }

    // ── Tool icons ──
    function getToolIconSvg(toolName) {
      const name = (toolName || '').toLowerCase();
      if (name.includes('read') || name.includes('file')) {
        return '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V5L9 1zM4 14V2h4v4h4v8H4z"/></svg>';
      }
      if (name.includes('edit') || name.includes('write')) {
        return '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M12.147 1.146a.5.5 0 0 1 .707 0l2 2a.5.5 0 0 1 0 .708l-9 9a.5.5 0 0 1-.232.138l-4 1a.5.5 0 0 1-.6-.6l1-4a.5.5 0 0 1 .138-.233l9-9zM4.5 11.5l-.793 2.293L6 13h5V8H6v3.5zM12 3.707L11.293 3 9 5.293 9.707 6 12 3.707z"/></svg>';
      }
      if (name.includes('search') || name.includes('find')) {
        return '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 6.5a5 5 0 1 1-10 0 5 5 0 0 1 10 0zm-.707 4.096a6 6 0 1 1 .707-.707l3.207 3.207-.707.707-3.207-3.207z"/></svg>';
      }
      if (name.includes('delete') || name.includes('remove')) {
        return '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 1h4v1h3v1H3V2h3V1zM4 4h8v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4zm2 2v7h1V6H6zm3 0v7h1V6H9z"/></svg>';
      }
      if (name.includes('move') || name.includes('rename')) {
        return '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 1L11 4.5H9v4H7v-4H5L7.5 1zM5 15l3.5-3.5H7v-4h2v4h2.5L7.5 15H5z"/></svg>';
      }
      if (name.includes('list') || name.includes('dir')) {
        return '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h6v2H2V2zm0 4h12v2H2V6zm0 4h12v2H2v-2zm0 4h8v2H2v-2z"/></svg>';
      }
      if (name.includes('diff')) {
        return '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1v14M1 8h14" stroke="currentColor" stroke-width="1" fill="none"/><path d="M5 4h6v1H5V4zm0 3h6v1H5V7zm0 3h4v1H5v-1z"/></svg>';
      }
      // default gear icon
      return '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm4.9 1.3l1.8-.5-.5-1.8-1.7.6a5 5 0 0 0-1.5-.9l-.4-1.8h-2l-.4 1.8a5 5 0 0 0-1.5.9l-1.7-.6-.5 1.8 1.8.5a5 5 0 0 0 0 1.8l-1.8.5.5 1.8 1.7-.6a5 5 0 0 0 1.5.9l.4 1.8h2l.4-1.8a5 5 0 0 0 1.5-.9l1.7.6.5-1.8-1.8-.5a5 5 0 0 0 0-1.8z"/></svg>';
    }

    function getStatusIcon(state) {
      switch (state) {
        case 'running': return '<div class="spinner"></div>';
        case 'success': return '<svg viewBox="0 0 16 16" fill="currentColor" style="width:12px;height:12px;"><path d="M6.5 10.5L3.5 7.5l-.7.7L6.5 12l7-7-.7-.7-6.3 6.2z"/></svg>';
        case 'error': return '<svg viewBox="0 0 16 16" fill="currentColor" style="width:12px;height:12px;"><path d="M8 1a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm3.5 9.5L10 11.5 8 9.5 6 11.5 4.5 10l2-2-2-2L6 4.5l2 2 2-2 1.5 1.5-2 2 2 2z"/></svg>';
        case 'pending':
        default: return '<svg viewBox="0 0 16 16" fill="currentColor" style="width:12px;height:12px;opacity:0.5;"><path d="M8 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 1a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm-1 1v5l4 2.5.7-1-3.7-2.2V4H7z"/></svg>';
      }
    }

    // ── Agent dropdown ──
    agentBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAgentDropdown();
    });

    document.addEventListener('click', (e) => {
      if (!agentDropdown.contains(e.target) && e.target !== agentBtn) {
        closeAgentDropdown();
      }
    });

    function toggleAgentDropdown() {
      if (agentDropdown.classList.contains('show')) {
        closeAgentDropdown();
      } else {
        openAgentDropdown();
      }
    }

    function openAgentDropdown() {
      agentDropdown.classList.add('show');
      agentBtn.classList.add('open');
    }

    function closeAgentDropdown() {
      agentDropdown.classList.remove('show');
      agentBtn.classList.remove('open');
    }

    function renderAgentDropdown() {
      agentDropdown.innerHTML = '';
      for (const a of agents) {
        const card = document.createElement('div');
        card.className = 'agent-card' + (a.agent_id === selectedAgentId ? ' selected' : '');
        card.setAttribute('role', 'option');
        const color = getAgentColor(a.agent_id, a.agent_name);
        card.innerHTML = \`
          <span class="agent-icon-dot" style="background: \${color};">\${getAgentInitial(a.agent_name)}</span>
          <span class="agent-info">
            <span class="agent-name">\${escapeHtml(a.agent_name)}</span>
            <span class="agent-model">\${escapeHtml(a.model || '--')}</span>
            <span class="agent-card-desc">\${escapeHtml(a.description || '')}</span>
          </span>
        \`;
        card.addEventListener('click', () => selectAgent(a.agent_id));
        agentDropdown.appendChild(card);
      }
    }

    function selectAgent(agentId) {
      const agent = agents.find(a => a.agent_id === agentId);
      if (!agent) return;
      selectedAgentId = agentId;
      const color = getAgentColor(agent.agent_id, agent.agent_name);
      agentIcon.style.background = color;
      agentIcon.textContent = getAgentInitial(agent.agent_name);
      agentName.textContent = agent.agent_name;
      agentModelText.textContent = agent.model || '--';
      closeAgentDropdown();
      renderAgentDropdown();
    }

    // ── Tools section ──
    toolsHeader.addEventListener('click', () => {
      toolsSection.classList.toggle('collapsed');
      toolsExpanded = !toolsSection.classList.contains('collapsed');
    });

    function updateToolsCount() {
      const count = toolEntries.size;
      toolsCount.textContent = count;
      if (count > 0) {
        toolsSection.classList.add('active');
        // Auto-expand when tools are active (running/pending)
        let hasActive = false;
        for (const entry of toolEntries.values()) {
          if (entry.state === 'running' || entry.state === 'pending') {
            hasActive = true;
            break;
          }
        }
        if (hasActive && !toolsExpanded) {
          toolsSection.classList.remove('collapsed');
        }
        // Auto-collapse when no tools active and was auto-expanded
        if (!hasActive && toolsSection.classList.contains('active') && !toolsExpanded) {
          // keep it visible but allow manual collapse
        }
      } else {
        toolsSection.classList.remove('active');
      }
    }

    function showToolState(tool, state, error, callId, input, output) {
      clearPlaceholder();
      let entry = toolEntries.get(callId);
      if (!entry) {
        // Create chip
        const chip = document.createElement('div');
        chip.className = 'tool-chip ' + state;
        chip.innerHTML = \`
          <span class="tool-icon">\${getToolIconSvg(tool)}</span>
          <span class="tool-chip-name">\${escapeHtml(tool)}</span>
          <span class="tool-chip-status">
            <span class="tool-status-icon">\${getStatusIcon(state)}</span>
          </span>
          <svg class="chevron" viewBox="0 0 16 16" fill="currentColor" style="width:10px;height:10px;">
            <path d="M4 6l4 4 4-4H4z"/>
          </svg>
        \`;

        const detail = document.createElement('div');
        detail.className = 'tool-detail';

        chip.addEventListener('click', () => {
          chip.classList.toggle('expanded');
        });

        toolsList.appendChild(chip);
        toolsList.appendChild(detail);
        entry = { chipEl: chip, detailEl: detail, state, tool };
        toolEntries.set(callId, entry);
      }

      // Update state
      entry.state = state;
      entry.chipEl.className = 'tool-chip ' + state + (entry.chipEl.classList.contains('expanded') ? ' expanded' : '');
      entry.chipEl.querySelector('.tool-status-icon').innerHTML = getStatusIcon(state);

      // Update detail
      let detailHtml = '';
      if (input !== undefined && input !== null) {
        detailHtml += \`<div class="tool-detail-section"><div class="tool-detail-label">输入</div>\${escapeHtml(typeof input === 'string' ? input : JSON.stringify(input, null, 2))}</div>\`;
      }
      if (error) {
        detailHtml += \`<div class="tool-detail-section" style="color: var(--error);"><div class="tool-detail-label">错误</div>\${escapeHtml(error)}</div>\`;
      } else if (output !== undefined && output !== null) {
        const outStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
        const truncated = outStr.length > 2000 ? outStr.substring(0, 2000) + '\\n... (已截断)' : outStr;
        detailHtml += \`<div class="tool-detail-section"><div class="tool-detail-label">输出</div>\${escapeHtml(truncated)}</div>\`;
      }
      entry.detailEl.innerHTML = detailHtml;

      updateToolsCount();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // ── Approval cards ──
    function showApprovalCard(callId, toolName, summary, filePath) {
      clearPlaceholder();
      if (approvalCards.has(callId)) return;

      const card = document.createElement('div');
      card.className = 'approval-card';
      card.innerHTML = \`
        <div class="approval-header">
          <svg class="approval-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
          </svg>
          <div class="approval-content">
            <div class="approval-tool-name">
              <span class="tool-icon" style="width:16px;height:16px;">\${getToolIconSvg(toolName)}</span>
              \${escapeHtml(toolName)}
            </div>
            <div class="approval-summary">\${escapeHtml(summary)}</div>
            \${filePath ? \`<div class="approval-file-path">\${escapeHtml(filePath)}</div>\` : ''}
          </div>
        </div>
        <div class="approval-actions">
          <button class="approval-btn allow" data-decision="allow">允许一次</button>
          <button class="approval-btn always" data-decision="always">始终允许</button>
          <button class="approval-btn deny" data-decision="deny">拒绝</button>
        </div>
      \`;

      card.querySelectorAll('.approval-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const decision = btn.getAttribute('data-decision');
          vscode.postMessage({
            command: 'approvalDecision',
            call_id: callId,
            decision: decision
          });
          card.style.opacity = '0.5';
          card.style.pointerEvents = 'none';
          const btns = card.querySelectorAll('.approval-btn');
          btns.forEach(b => b.disabled = true);
        });
      });

      // Insert into the current assistant message or at the end
      if (currentAssistantEl) {
        currentAssistantEl.parentNode.appendChild(card);
      } else {
        const row = appendAssistantRow();
        row.appendChild(card);
      }

      approvalCards.set(callId, card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // ── Diff cards ──
    function showDiffCard(callId, filePath, diffHtml, additions, deletions) {
      clearPlaceholder();
      if (diffCards.has(callId)) {
        const existing = diffCards.get(callId);
        existing.remove();
      }

      const card = document.createElement('div');
      card.className = 'diff-card';
      card.innerHTML = \`
        <div class="diff-header">
          <svg class="diff-icon" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6.5L8.5 1zM9 2.5L12.5 6H9V2.5zM5 14V2h3v5h5v7H5z"/>
          </svg>
          <span class="diff-filename">\${escapeHtml(filePath)}</span>
          <span class="diff-stats">
            <span class="diff-additions">+\${additions || 0}</span>
            <span class="diff-deletions">-\${deletions || 0}</span>
          </span>
          <svg class="diff-chevron" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 6l4 4 4-4H4z"/>
          </svg>
        </div>
        <div class="diff-body">
          <div class="diff-content">
            <table class="diff-table">\${diffHtml || ''}</table>
          </div>
          <div class="diff-footer">
            <a onclick="vscode.postMessage({command: 'openDiff', file_path: '\${filePath.replace(/'/g, "\\\\'")}'})">在差异编辑器中打开 →</a>
          </div>
        </div>
      \`;

      card.querySelector('.diff-header').addEventListener('click', () => {
        card.classList.toggle('expanded');
      });

      if (currentAssistantEl) {
        currentAssistantEl.parentNode.appendChild(card);
      } else {
        const row = appendAssistantRow();
        row.appendChild(card);
      }

      diffCards.set(callId, card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // ── Utility ──
    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      const div = document.createElement('div');
      div.textContent = String(str);
      return div.innerHTML;
    }

    // ── Event bindings ──
    sendBtn.addEventListener('click', handleSend);

    stopBtn.addEventListener('click', () => {
      if (currentSessionId) {
        vscode.postMessage({ command: 'stopStream', sessionId: currentSessionId });
      }
    });

    newSessBtn.addEventListener('click', startNewSession);

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });

    inputEl.addEventListener('input', autoResize);

    function autoResize() {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    }

    function startNewSession() {
      if (!selectedAgentId) {
        // Try first agent if available
        if (agents.length > 0) {
          selectAgent(agents[0].agent_id);
        } else {
          showError('请先选择一个 Agent');
          return;
        }
      }
      vscode.postMessage({ command: 'createSession', agentId: selectedAgentId });
    }

    function handleSend() {
      const text = inputEl.value.trim();
      if (!text || !currentSessionId || isStreaming) return;

      appendUserMsg(text);
      inputEl.value = '';
      autoResize();
      setStreaming(true);
      currentAssistantTxt = '';
      currentAssistantEl = null;

      vscode.postMessage({ command: 'sendMessage', sessionId: currentSessionId, text });
    }

    // ── Message rendering ──
    function clearPlaceholder() {
      const p = messagesEl.querySelector('.placeholder');
      if (p) p.remove();
    }

    function appendUserMsg(text) {
      clearPlaceholder();
      const row = document.createElement('div');
      row.className = 'msg-row';
      row.innerHTML = '<div class="msg-label" style="text-align:right;justify-content:flex-end;">你</div>';
      const bubble = document.createElement('div');
      bubble.className = 'message user';
      bubble.textContent = text;
      row.appendChild(bubble);
      messagesEl.appendChild(row);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendAssistantRow() {
      clearPlaceholder();
      const row = document.createElement('div');
      row.className = 'msg-row';
      row.innerHTML = '<div class="msg-label">Agent</div>';
      const bubble = document.createElement('div');
      bubble.className = 'message assistant cursor';
      row.appendChild(bubble);
      messagesEl.appendChild(row);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return bubble;
    }

    function updateAssistantMsg(chunk) {
      currentAssistantTxt += chunk;
      if (!currentAssistantEl) { currentAssistantEl = appendAssistantRow(); }
      if (typeof window.marked !== 'undefined') {
        currentAssistantEl.innerHTML = window.marked.parse(currentAssistantTxt, { breaks: true });
      } else {
        currentAssistantEl.textContent = currentAssistantTxt;
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendMsgFromHistory(role, text) {
      if (role === 'user') { appendUserMsg(text); return; }
      const row = document.createElement('div');
      row.className = 'msg-row';
      row.innerHTML = '<div class="msg-label">Agent</div>';
      const bubble = document.createElement('div');
      bubble.className = 'message assistant';
      if (typeof window.marked !== 'undefined') {
        bubble.innerHTML = window.marked.parse(text, { breaks: true });
      } else {
        bubble.textContent = text;
      }
      row.appendChild(bubble);
      messagesEl.appendChild(row);
    }

    function showThought(text) {
      clearPlaceholder();
      const row = document.createElement('div');
      row.className = 'msg-row';
      const label = document.createElement('div');
      label.className = 'msg-label';
      label.innerHTML = \`
        <svg viewBox="0 0 16 16" fill="currentColor" style="width:12px;height:12px;opacity:0.6;">
          <path d="M8 1a5 5 0 0 1 4.9 4.1A3.5 3.5 0 0 1 12.5 12H11v-1h1.5a2.5 2.5 0 0 0 .4-4.97A4 4 0 1 0 4 6.5a3 3 0 0 0-.5 5.97V13h1v-.5A3 3 0 0 0 7 9.5 3.5 3.5 0 0 1 8 2.5z"/>
        </svg>
        思考
      \`;
      const bubble = document.createElement('div');
      bubble.className = 'message thought';
      bubble.textContent = text;
      row.appendChild(label);
      row.appendChild(bubble);
      messagesEl.appendChild(row);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function showPlan(steps) {
      clearPlaceholder();
      const row = document.createElement('div');
      row.className = 'msg-row';
      const label = document.createElement('div');
      label.className = 'msg-label';
      label.innerHTML = \`
        <svg viewBox="0 0 16 16" fill="currentColor" style="width:12px;height:12px;opacity:0.6;">
          <path d="M1 3h10v1H1V3zm0 4h10v1H1V7zm0 4h7v1H1v-1zm12-7v5h1V4h-1zm0 6v3h1v-3h-1z"/>
        </svg>
        计划
      \`;
      const bubble = document.createElement('div');
      bubble.className = 'message plan';
      const ol = document.createElement('ol');
      for (const s of steps) {
        const li = document.createElement('li');
        li.textContent = s;
        ol.appendChild(li);
      }
      bubble.appendChild(ol);
      row.appendChild(label);
      row.appendChild(bubble);
      messagesEl.appendChild(row);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function showError(msg) {
      errorEl.textContent = msg;
      setTimeout(() => { if (errorEl.textContent === msg) errorEl.textContent = ''; }, 5000);
    }

    function setStreaming(state) {
      isStreaming = state;
      sendBtn.style.display = state ? 'none' : 'inline-flex';
      stopBtn.style.display = state ? 'inline-flex' : 'none';
      stopBtn.disabled = !state;
      sendBtn.disabled = state || !currentSessionId;
      inputEl.disabled = !currentSessionId;
    }

    // ── Host message handler ──
    window.addEventListener('message', (e) => {
      const msg = e.data;
      switch (msg.command) {
        case 'agentsLoaded': {
          agents = msg.agents || [];
          renderAgentDropdown();
          if (agents.length > 0 && !selectedAgentId) {
            selectAgent(agents[0].agent_id);
          }
          break;
        }
        case 'sessionCreated': {
          currentSessionId = msg.sessionId;
          messagesEl.innerHTML = '';
          toolEntries.clear();
          approvalCards.clear();
          diffCards.clear();
          toolsList.innerHTML = '';
          updateToolsCount();
          inputEl.disabled = false;
          sendBtn.disabled = false;
          setStreaming(false);
          vscode.postMessage({ command: 'loadHistory', sessionId: currentSessionId });
          break;
        }
        case 'replyChunk':
          updateAssistantMsg(msg.text);
          break;
        case 'replyEnd':
          setStreaming(false);
          if (currentAssistantEl) currentAssistantEl.classList.remove('cursor');
          currentAssistantEl = null;
          currentAssistantTxt = '';
          break;
        case 'toolState':
          showToolState(msg.tool, msg.state, msg.error, msg.call_id, msg.input, msg.output);
          break;
        case 'thought':
          showThought(msg.text);
          break;
        case 'plan':
          showPlan(msg.steps);
          break;
        case 'historyLoaded':
          messagesEl.innerHTML = '';
          toolEntries.clear();
          approvalCards.clear();
          diffCards.clear();
          toolsList.innerHTML = '';
          updateToolsCount();
          if (msg.messages.length === 0) {
            messagesEl.innerHTML = \`
              <div class="placeholder">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor" style="display:block;margin:0 auto 10px;">
                  <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/>
                </svg>
                <div class="placeholder-title">会话已创建</div>
                发送第一条消息开始对话
              </div>\`;
          }
          for (const m of msg.messages) appendMsgFromHistory(m.role, m.content);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        case 'error':
          showError(msg.message);
          if (isStreaming) {
            setStreaming(false);
            if (currentAssistantEl) currentAssistantEl.classList.remove('cursor');
            currentAssistantEl = null;
            currentAssistantTxt = '';
          }
          break;
        case 'triggerNewSession':
          startNewSession();
          break;
        case 'approvalRequest':
          showApprovalCard(msg.call_id, msg.tool_name, msg.summary, msg.file_path);
          break;
        case 'diffResult':
          showDiffCard(msg.call_id, msg.file_path, msg.diff_html, msg.additions, msg.deletions);
          break;
      }
    });

    // init
    vscode.postMessage({ command: 'requestAgents' });
`;
	}
}
