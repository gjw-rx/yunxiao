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
  private readonly _sessionNames = new Map<string, string>();

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
      async (msg: { command: string;[key: string]: unknown }) => {
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
        const p = e.payload as {
          call_id: string;
          state: string;
          tool: string;
          error?: string;
          args?: unknown;
          output?: unknown;
        };
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

  private async _handleMessage(msg: { command: string;[key: string]: unknown }): Promise<void> {
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
      case 'openFile': {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: '打开文件',
          title: '选择要打开的文件',
        });
        if (uris?.[0]) {
          await vscode.commands.executeCommand('vscode.open', uris[0]);
        }
        break;
      }
      case 'requestWorkspaceFiles': {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        if (workspaceFolders.length === 0) {
          view.webview.postMessage({ command: 'workspaceFiles', files: [] });
          break;
        }
        const uris = await vscode.workspace.findFiles(
          '**/*',
          '**/{node_modules,.git,.venv,dist,out,coverage}/**',
          300,
        );
        const files = uris
          .map((uri) => {
            const folder = vscode.workspace.getWorkspaceFolder(uri);
            const relativePath = folder
              ? path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/')
              : path.basename(uri.fsPath);
            const displayPath = workspaceFolders.length > 1 && folder
              ? `${folder.name}/${relativePath}`
              : relativePath;
            return { path: displayPath, name: path.basename(uri.fsPath) };
          })
          .sort((a, b) => a.path.localeCompare(b.path));
        view.webview.postMessage({ command: 'workspaceFiles', files });
        break;
      }
      case 'renameSession': {
        const sessionId = msg.sessionId as string;
        const name = msg.name as string;
        if (sessionId && name) {
          this._sessionNames.set(sessionId, name);
        }
        break;
      }
      case 'showHistory': {
        // 简化版：返回当前会话名称列表
        const sessions: { session_id: string; name: string }[] = [];
        for (const [sid, name] of this._sessionNames) {
          sessions.push({ session_id: sid, name });
        }
        if (this._currentSessionId && !this._sessionNames.has(this._currentSessionId)) {
          sessions.unshift({ session_id: this._currentSessionId, name: 'Untitled' });
        }
        view.webview.postMessage({ command: 'historyList', sessions });
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
      /* 时间线轨道与步骤节点 */
      --rail: color-mix(in srgb, var(--fg) 16%, transparent);
      --rail-active: var(--accent);
      --step-bg: color-mix(in srgb, var(--fg) 4%, transparent);
      --step-bg-hover: color-mix(in srgb, var(--fg) 8%, transparent);
      --label-tracking: 0.08em;
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
    }

    /* ── Session name input ── */
    .session-name-input {
      flex: 1;
      min-width: 0;
      background: transparent;
      color: var(--fg);
      border: 1px solid transparent;
      border-radius: var(--radius);
      padding: 4px 8px;
      font-family: var(--font);
      font-size: 13px;
      font-weight: 500;
      outline: none;
      transition: border-color 0.15s, background 0.15s;
    }
    .session-name-input:hover { border-color: var(--border-light); }
    .session-name-input:focus {
      border-color: var(--focus);
      background: var(--input-bg);
    }

    /* ── Compact Agent selector (in toolbar) ── */
    .agent-selector-compact {
      position: relative;
      flex-shrink: 0;
    }

    .agent-compact-btn {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 3px 6px;
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      cursor: pointer;
      font-family: var(--font);
      font-size: 11px;
      transition: border-color 0.15s, background 0.15s;
    }
    .agent-compact-btn:hover { border-color: var(--muted); background: var(--hover-bg); }
    .agent-compact-btn:focus { outline: none; border-color: var(--focus); }
    .agent-compact-btn.open { border-color: var(--focus); }

    .agent-compact-btn .agent-icon-dot {
      width: 16px;
      height: 16px;
      font-size: 9px;
    }

    .agent-compact-name {
      max-width: 80px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .agent-compact-btn .chevron {
      width: 10px;
      height: 10px;
    }

    /* Dropdown panel (shared) */
    #agentDropdown {
      position: absolute;
      bottom: calc(100% + 4px);
      right: 0;
      left: auto;
      min-width: 220px;
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

    /* Dropdown card content (shared) */
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

    /* ── Spinner ── */
    .spinner {
      width: 11px;
      height: 11px;
      border: 1.5px solid transparent;
      border-top-color: currentColor;
      border-right-color: currentColor;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Messages area ── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 14px 12px 8px;
      display: flex;
      flex-direction: column;
      scroll-behavior: smooth;
    }

    .placeholder {
      text-align: center;
      color: var(--muted);
      margin: auto;
      font-size: 12px;
      line-height: 1.7;
      padding: 30px 14px;
      animation: rise 0.35s ease both;
    }
    .placeholder svg { opacity: 0.28; margin-bottom: 12px; }
    .placeholder-title {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.02em;
      margin-bottom: 5px;
      color: var(--fg);
      opacity: 0.75;
    }

    .msg-row {
      display: flex;
      flex-direction: column;
      max-width: 100%;
      margin-bottom: 18px;
      animation: rise 0.24s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: none; }
    }

    .msg-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: var(--label-tracking);
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .message {
      line-height: 1.65;
      font-size: 13px;
      word-break: break-word;
    }

    /* 用户消息：靠右，内敛的实心块 */
    .msg-row.user-row { align-items: flex-end; }
    .message.user {
      background: var(--step-bg);
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 8px 12px;
      border-radius: 10px 10px 3px 10px;
      white-space: pre-wrap;
      max-width: 90%;
    }

    /* 助手最终回复：全宽正文，不用气泡 */
    .message.assistant {
      max-width: 100%;
      padding-left: 1px;
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

    /* ══ 回合（turn）容器 ══
       一个 turn = 过程时间线（思考/工具）+ 最终回复。
       时间线永远排在回复之前。 */
    .turn {
      display: flex;
      flex-direction: column;
      margin-bottom: 18px;
    }

    /* ── 过程时间线 ── */
    .trace {
      position: relative;
      margin-bottom: 10px;
      animation: rise 0.24s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .trace:empty { display: none; }

    /* 竖向轨道 */
    .trace::before {
      content: '';
      position: absolute;
      left: 7px;
      top: 20px;
      bottom: 6px;
      width: 1px;
      background: var(--rail);
    }

    .trace-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: var(--label-tracking);
      text-transform: uppercase;
      color: var(--muted);
      cursor: pointer;
      user-select: none;
      padding: 2px 0 8px;
      transition: color 0.15s;
    }
    .trace-header:hover { color: var(--fg); }
    .trace-header .chevron {
      width: 10px;
      height: 10px;
      transition: transform 0.2s;
    }
    .trace.collapsed .trace-header .chevron { transform: rotate(-90deg); }

    .trace-count {
      font-family: var(--mono);
      font-weight: 500;
      letter-spacing: 0;
      opacity: 0.7;
    }
    .trace-live {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--accent);
      animation: pulse 1.4s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%      { opacity: 0.35; transform: scale(0.7); }
    }

    .trace-body { display: flex; flex-direction: column; gap: 1px; }
    .trace.collapsed .trace-body { display: none; }
    .trace.collapsed::before { display: none; }

    /* ── 时间线步骤（思考 / 工具 / 计划共用） ── */
    .step {
      position: relative;
      padding-left: 22px;
      animation: rise 0.2s ease both;
    }

    /* 节点圆点，压在轨道上 */
    .step-dot {
      position: absolute;
      left: 3px;
      top: 6px;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--bg);
      border: 1.5px solid var(--rail);
      box-sizing: border-box;
      z-index: 1;
    }
    .step.running .step-dot {
      border-color: var(--rail-active);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
    }
    .step.success .step-dot { border-color: var(--success); background: var(--success); }
    .step.error   .step-dot { border-color: var(--error);   background: var(--error); }

    .step-head {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 4px 6px 4px 0;
      border-radius: var(--radius);
      font-size: 12px;
      min-height: 22px;
    }
    .step.clickable > .step-head { cursor: pointer; }
    .step.clickable > .step-head:hover { background: var(--step-bg-hover); }

    .step-icon {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
    }
    .step-icon svg { width: 13px; height: 13px; }
    .step.running .step-icon { color: var(--accent); }

    /* 工具名用等宽字体，与散文正文形成对照 */
    .step-name {
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--fg);
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* 主要参数就地预览，省去展开动作 */
    .step-arg {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: rtl;
      text-align: left;
    }

    .step-status {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      color: var(--muted);
      width: 13px;
      height: 13px;
    }
    .step.running .step-status { color: var(--accent); }
    .step.success .step-status { color: var(--success); }
    .step.error   .step-status { color: var(--error); }

    .step-chevron {
      width: 9px;
      height: 9px;
      flex-shrink: 0;
      color: var(--muted);
      opacity: 0;
      transition: transform 0.2s, opacity 0.15s;
    }
    .step.clickable:hover .step-chevron { opacity: 0.7; }
    .step.expanded .step-chevron { opacity: 0.7; transform: rotate(180deg); }

    /* 步骤详情 */
    .step-detail {
      display: none;
      margin: 2px 0 6px;
      border-left: 1px solid var(--border);
      padding-left: 10px;
    }
    .step.expanded .step-detail { display: block; }

    .detail-label {
      font-size: 9px;
      font-weight: 600;
      letter-spacing: var(--label-tracking);
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 3px;
    }
    .detail-block {
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--step-bg);
      border-radius: 4px;
      padding: 6px 8px;
      max-height: 200px;
      overflow: auto;
      margin-bottom: 7px;
    }
    .detail-block:last-child { margin-bottom: 0; }
    .detail-block.is-error { color: var(--error); }

    /* ── 思考步骤 ── */
    .step.thought .step-body {
      font-size: 12px;
      line-height: 1.6;
      color: var(--muted);
      padding: 1px 0 5px;
      white-space: pre-wrap;
    }
    .step.thought.collapsed-text .step-body {
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    /* ── 计划步骤 ── */
    .step.plan ol {
      margin: 2px 0 6px;
      padding-left: 18px;
      font-size: 12px;
      color: var(--fg);
    }
    .step.plan li { margin: 2px 0; line-height: 1.55; }

    /* ── Approval card ── */
    .approval-card {
      background: var(--vscode-inputValidation-warningBackground, rgba(210,153,34,0.08));
      border: 1px solid var(--warning);
      border-left-width: 3px;
      border-radius: var(--radius-lg);
      padding: 11px 12px;
      margin: 4px 0 10px;
      animation: rise 0.2s ease both;
    }
    /* 决定作出后卡片退场，不留常驻残影 */
    .approval-card.resolving {
      animation: fold 0.22s ease forwards;
      pointer-events: none;
      overflow: hidden;
    }
    @keyframes fold {
      from { opacity: 1; transform: none; }
      to   { opacity: 0; transform: translateY(-3px); }
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
      font-size: 12px;
      font-family: var(--mono);
      margin-bottom: 5px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .approval-tool-name .step-icon { color: var(--warning); }

    .approval-kicker {
      font-family: var(--font);
      font-size: 9px;
      font-weight: 600;
      letter-spacing: var(--label-tracking);
      text-transform: uppercase;
      color: var(--warning);
      margin-left: auto;
      flex-shrink: 0;
    }

    .approval-summary {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--fg);
      line-height: 1.5;
      margin-bottom: 6px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 96px;
      overflow: hidden;
      position: relative;
    }
    /* 长摘要（如 diff）底部淡出，避免撑爆卡片 */
    .approval-summary.clipped::after {
      content: '';
      position: absolute;
      left: 0; right: 0; bottom: 0;
      height: 28px;
      background: linear-gradient(transparent, var(--bg));
    }
    .approval-summary.open {
      max-height: 340px;
      overflow: auto;
    }
    .approval-summary.open::after { display: none; }

    .approval-more {
      font-size: 11px;
      color: var(--accent);
      cursor: pointer;
      margin-bottom: 8px;
      display: inline-block;
      user-select: none;
    }
    .approval-more:hover { text-decoration: underline; }

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
      transition: background 0.12s, border-color 0.12s, transform 0.1s;
    }
    .approval-btn:active { transform: scale(0.97); }

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
      position: relative;
      padding: 8px 10px 10px;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
      background: var(--bg);
    }

    #filePicker {
      position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); display: none;
      overflow: hidden; background: var(--vscode-quickInput-background, var(--vscode-editor-background, #252526));
      border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 30px rgba(0,0,0,0.28); z-index: 110;
      animation: picker-rise 0.14s ease-out both;
    }
    #filePicker.show { display: block; }
    .file-picker-heading { display: flex; justify-content: space-between; padding: 8px 10px 6px; color: var(--muted); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; }
    .file-picker-hint { opacity: 0.7; text-transform: none; letter-spacing: 0; }
    #filePickerList { max-height: 220px; overflow-y: auto; padding: 0 4px 4px; }
    .file-option { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--fg); cursor: pointer; text-align: left; font: inherit; }
    .file-option:hover, .file-option.active { background: var(--vscode-list-activeSelectionBackground, var(--hover-bg)); color: var(--vscode-list-activeSelectionForeground, var(--fg)); }
    .file-option-icon { color: var(--muted); flex: 0 0 auto; }
    .file-option-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .file-picker-empty { padding: 12px 10px; color: var(--muted); font-size: 12px; }
    @keyframes picker-rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    #inputWrapper {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 10px;
      padding: 8px 10px;
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

    /* ── Input toolbar ── */
    .input-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 2px 0;
      gap: 6px;
    }
    .toolbar-left, .toolbar-right {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .open-file-btn {
      width: 28px;
      height: 28px;
      padding: 0;
      border: 1px solid transparent;
      color: var(--muted);
      transition: color 0.15s, background 0.15s, border-color 0.15s, transform 0.15s;
    }
    .open-file-btn:hover:not(:disabled) {
      color: var(--fg);
      background: var(--hover-bg);
      border-color: var(--border-light);
    }
    .open-file-btn:active:not(:disabled) { transform: scale(0.92); }
    .open-file-btn:focus-visible { outline: 1px solid var(--focus); outline-offset: 1px; }
    .open-file-btn svg { width: 15px; height: 15px; }

    /* Shared icon-dot style (used in compact agent btn + dropdown cards) */
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

    .chevron {
      width: 12px;
      height: 12px;
      flex-shrink: 0;
      transition: transform 0.2s;
      color: var(--muted);
    }
    .agent-compact-btn.open .chevron { transform: rotate(180deg); }

    #sendBtn, #stopBtn {
      width: 28px;
      height: 28px;
      padding: 0;
      border-radius: 6px;
      flex-shrink: 0;
    }

    .session-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
    .session-actions .btn-icon { width: 26px; height: 26px; padding: 0; color: var(--muted); }
    .session-actions .btn-icon:hover:not(:disabled) { color: var(--fg); }

    #hint {
      text-align: center;
      font-size: 10px;
      color: var(--muted);
      margin-top: 5px;
      opacity: 0.7;
    }`;
  }

  private _getBodyHtml(): string {
    return `
  <div id="header">
    <input id="sessionNameInput" class="session-name-input" type="text" value="Untitled" placeholder="会话名称" />
    <div class="session-actions">
      <button id="newSessionIconBtn" class="btn btn-icon" title="新建会话">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7.25 1a.75.75 0 0 1 .75.75V7h5.25a.75.75 0 0 1 0 1.5H8v5.25a.75.75 0 0 1-1.5 0V8.5H1.25a.75.75 0 0 1 0-1.5H6.5V1.75A.75.75 0 0 1 7.25 1z"/></svg>
      </button>
      <button id="historyBtn" class="btn btn-icon" title="历史会话">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 2C4.69 2 2 4.69 2 8s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm0 11c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm.5-8H7v3.21l2.65 2.65.71-.71L8.5 7.79V5z"/>
      </svg>
      </button>
    </div>
  </div>

  <div id="messages">
    <div class="placeholder">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor" style="display:block;margin:0 auto 10px;">
        <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/>
      </svg>
      <div class="placeholder-title">欢迎使用云效 Agent</div>
      输入消息开始对话，用 @ 引用文件
    </div>
  </div>

  <div id="error"></div>

  <div id="inputArea">
    <div id="filePicker" role="listbox" aria-label="选择工作区文件">
      <div class="file-picker-heading"><span>工作区文件</span><span class="file-picker-hint">↑↓ 选择 · Enter 确认 · Esc 关闭</span></div>
      <div id="filePickerList"></div>
    </div>
    <div id="inputWrapper">
      <textarea id="input" rows="1" placeholder="输入消息... 使用 @ 引用文件" disabled></textarea>
    </div>
    <div id="inputToolbar" class="input-toolbar">
      <div class="toolbar-left">
        <button id="openFileBtn" class="btn btn-icon open-file-btn" title="打开文件" aria-label="打开文件">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 2v12M2 8h12" />
          </svg>
        </button>
      </div>
      <div class="toolbar-right">
        <div id="agentSelectorCompact" class="agent-selector-compact">
          <button id="agentBtn" class="agent-compact-btn" aria-haspopup="listbox" title="选择 Agent">
            <span class="agent-icon-dot" id="agentIcon" style="background: #6c757d;">?</span>
            <span class="agent-compact-name" id="agentName">Agent</span>
            <svg class="chevron" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 6l4 4 4-4H4z"/>
            </svg>
          </button>
          <div id="agentDropdown" role="listbox"></div>
        </div>
        <button id="sendBtn" class="btn btn-icon" disabled title="发送 (Enter)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.5 1.5l13 6.5-13 6.5V8.75l8-1.25-8-1.25V1.5z"/>
          </svg>
        </button>
        <button id="stopBtn" class="btn btn-stop btn-icon" style="display:none" title="停止">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <rect x="1" y="1" width="8" height="8" rx="1"/>
          </svg>
        </button>
      </div>
    </div>
    <div id="hint">Enter 发送 &middot; Shift+Enter 换行 &middot; @ 引用文件</div>
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
    const openFileBtn  = document.getElementById('openFileBtn');
    const newSessBtn   = document.getElementById('newSessionIconBtn');
    const historyBtn   = document.getElementById('historyBtn');
    const sessionNameInput = document.getElementById('sessionNameInput');
    const errorEl      = document.getElementById('error');
    const agentBtn     = document.getElementById('agentBtn');
    const agentDropdown= document.getElementById('agentDropdown');
    const agentIcon    = document.getElementById('agentIcon');
    const agentName    = document.getElementById('agentName');
    const filePicker   = document.getElementById('filePicker');
    const filePickerList = document.getElementById('filePickerList');

    // ── State ──
    let agents = [];
    let selectedAgentId = null;
    let currentSessionId = null;
    let isStreaming = false;
    let workspaceFiles = [];
    let filePickerIndex = 0;
    let filePickerAtStart = -1;
    let filteredFiles = [];

    /* 「回合」模型：一轮对话 = 过程时间线（思考/工具/审批）+ 最终回复。
       时间线容器先于回复气泡插入 DOM，因此过程天然呈现在回复之上。 */
    let currentTurn = null;        // { rootEl, traceEl, traceBodyEl, countEl, liveEl, stepCount }
    let currentAssistantEl = null; // 当前流式回复气泡
    let currentAssistantTxt = '';
    const toolEntries = new Map();   // call_id -> { stepEl, detailEl, state, tool }
    const approvalCards = new Map(); // call_id -> card element
    const diffCards = new Map();     // call_id -> card element

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
      if (name.includes('terminal') || name.includes('exec')) {
        return '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 2h14v12H1V2zm1 2v8h12V4H2zm2 1.5L5.5 7 4 8.5V5.5zm0 3L5.5 10 4 11.5v-3zM7 9h4v1H7V9z"/></svg>';
      }
      if (name.includes('git') || name.includes('commit') || name.includes('branch') || name.includes('stash') || name.includes('status')) {
        return '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm10 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM7 3H5.9a3 3 0 0 1 0 6h4.2a3 3 0 0 1 0 6H11v2H9v-4h1a1 1 0 0 0 0-2H5.9a5 5 0 0 0 0-10H7V1l3 2.5L7 6V3z"/></svg>';
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
      if (!filePicker.contains(e.target) && e.target !== inputEl) {
        closeFilePicker();
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
      closeAgentDropdown();
      renderAgentDropdown();
    }

    // ══ 回合与过程时间线 ══

    /** 取得（或懒创建）当前回合。回合内 trace 在前、回复在后。 */
    function ensureTurn() {
      if (currentTurn) return currentTurn;
      clearPlaceholder();

      const root = document.createElement('div');
      root.className = 'turn';

      const trace = document.createElement('div');
      trace.className = 'trace';

      const header = document.createElement('div');
      header.className = 'trace-header';
      header.innerHTML = \`
        <svg class="chevron" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 6l4 4 4-4H4z"/>
        </svg>
        <span>过程</span>
        <span class="trace-count">0</span>
        <span class="trace-live"></span>
      \`;
      header.addEventListener('click', () => trace.classList.toggle('collapsed'));

      const body = document.createElement('div');
      body.className = 'trace-body';

      trace.appendChild(header);
      trace.appendChild(body);
      root.appendChild(trace);
      messagesEl.appendChild(root);

      currentTurn = {
        rootEl: root,
        traceEl: trace,
        traceBodyEl: body,
        countEl: header.querySelector('.trace-count'),
        liveEl: header.querySelector('.trace-live'),
        stepCount: 0,
      };
      return currentTurn;
    }

    /** 把一个步骤挂到当前回合的时间线上。 */
    function addStep(el) {
      const turn = ensureTurn();
      turn.traceBodyEl.appendChild(el);
      turn.stepCount += 1;
      turn.countEl.textContent = turn.stepCount;
      scrollToBottom();
      return turn;
    }

    /** 回合收尾：停掉 live 指示灯，过程默认折叠，让最终回复成为焦点。 */
    function finishTurn() {
      if (!currentTurn) return;
      if (currentTurn.liveEl) currentTurn.liveEl.style.display = 'none';
      if (currentTurn.stepCount > 0) currentTurn.traceEl.classList.add('collapsed');
      currentTurn = null;
    }

    /** 从工具入参里挑一个最有信息量的字段做行内预览。 */
    function summarizeArgs(args) {
      if (!args || typeof args !== 'object') {
        return typeof args === 'string' ? args : '';
      }
      const keys = ['path', 'file_path', 'pattern', 'query', 'command', 'dir', 'url', 'message', 'name'];
      for (const k of keys) {
        const v = args[k];
        if (typeof v === 'string' && v) return v;
      }
      return '';
    }

    function stringify(v) {
      if (v === null || v === undefined) return '';
      return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    }

    function truncate(s, max) {
      return s.length > max ? s.slice(0, max) + '\\n… (已截断)' : s;
    }

    function showToolState(tool, state, error, callId, args, output) {
      let entry = toolEntries.get(callId);

      if (!entry) {
        const step = document.createElement('div');
        step.className = 'step tool clickable ' + state;
        step.innerHTML = \`
          <span class="step-dot"></span>
          <div class="step-head">
            <span class="step-icon">\${getToolIconSvg(tool)}</span>
            <span class="step-name">\${escapeHtml(tool)}</span>
            <span class="step-arg"></span>
            <span class="step-status">\${getStatusIcon(state)}</span>
            <svg class="step-chevron" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 6l4 4 4-4H4z"/>
            </svg>
          </div>
        \`;

        const detail = document.createElement('div');
        detail.className = 'step-detail';
        step.appendChild(detail);

        step.querySelector('.step-head').addEventListener('click', () => {
          step.classList.toggle('expanded');
        });

        entry = { stepEl: step, detailEl: detail, state, tool };
        toolEntries.set(callId, entry);
        addStep(step);
      }

      // 状态推进：保留展开态
      entry.state = state;
      const wasExpanded = entry.stepEl.classList.contains('expanded');
      entry.stepEl.className =
        'step tool clickable ' + state + (wasExpanded ? ' expanded' : '');
      entry.stepEl.querySelector('.step-status').innerHTML = getStatusIcon(state);

      const argPreview = summarizeArgs(args);
      if (argPreview) {
        entry.stepEl.querySelector('.step-arg').textContent = argPreview;
      }

      let html = '';
      if (args !== undefined && args !== null) {
        html += \`<div class="detail-label">参数</div><div class="detail-block">\${escapeHtml(truncate(stringify(args), 1200))}</div>\`;
      }
      if (error) {
        html += \`<div class="detail-label">错误</div><div class="detail-block is-error">\${escapeHtml(error)}</div>\`;
      } else if (output !== undefined && output !== null) {
        html += \`<div class="detail-label">结果</div><div class="detail-block">\${escapeHtml(truncate(stringify(output), 2000))}</div>\`;
      }
      entry.detailEl.innerHTML = html;

      scrollToBottom();
    }

    // ══ 审批卡片 ══

    /** 决定已作出：卡片退场并销毁，不在时间线里留常驻残影。 */
    function dismissApprovalCard(callId) {
      const card = approvalCards.get(callId);
      if (!card) return;
      approvalCards.delete(callId);
      card.classList.add('resolving');
      const drop = () => card.remove();
      card.addEventListener('animationend', drop, { once: true });
      setTimeout(drop, 400); // 动画被跳过时的兜底
    }

    function showApprovalCard(callId, toolName, summary, filePath) {
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
              <span class="step-icon">\${getToolIconSvg(toolName)}</span>
              \${escapeHtml(toolName)}
              <span class="approval-kicker">待确认</span>
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

      card.querySelectorAll('.approval-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({
            command: 'approvalDecision',
            call_id: callId,
            decision: btn.getAttribute('data-decision'),
          });
          dismissApprovalCard(callId);
        });
      });

      // 审批也属于「过程」，进时间线
      addStep(card);
      approvalCards.set(callId, card);

      // 入 DOM 后才能量高度：长摘要（diff 等）折起，需要时再展开
      const summaryEl = card.querySelector('.approval-summary');
      if (summaryEl.scrollHeight > summaryEl.clientHeight + 4) {
        summaryEl.classList.add('clipped');
        const more = document.createElement('span');
        more.className = 'approval-more';
        more.textContent = '展开全部';
        more.addEventListener('click', () => {
          const open = summaryEl.classList.toggle('open');
          summaryEl.classList.toggle('clipped', !open);
          more.textContent = open ? '收起' : '展开全部';
        });
        summaryEl.parentNode.insertBefore(more, summaryEl.nextSibling);
      }

      scrollToBottom();
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

      addStep(card);
      diffCards.set(callId, card);
      scrollToBottom();
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

    openFileBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'openFile' });
    });

    historyBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'showHistory' });
    });

    // ── Session name editing ──
    sessionNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sessionNameInput.blur(); }
    });
    sessionNameInput.addEventListener('blur', () => {
      const name = sessionNameInput.value.trim() || 'Untitled';
      sessionNameInput.value = name;
      if (currentSessionId) {
        vscode.postMessage({ command: 'renameSession', sessionId: currentSessionId, name });
      }
    });

    inputEl.addEventListener('keydown', (e) => {
      if (filePicker.classList.contains('show')) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (filteredFiles.length === 0) return;
          filePickerIndex = (filePickerIndex + (e.key === 'ArrowDown' ? 1 : -1) + filteredFiles.length) % filteredFiles.length;
          renderFilePicker();
          return;
        }
        if (e.key === 'Enter') { e.preventDefault(); selectFile(filteredFiles[filePickerIndex]); return; }
        if (e.key === 'Escape') { e.preventDefault(); closeFilePicker(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });

    inputEl.addEventListener('input', autoResize);

    // ── @ file selection ──
    inputEl.addEventListener('input', handleAtTrigger);

    function handleAtTrigger() {
      const cursorPos = inputEl.selectionStart;
      const text = inputEl.value.substring(0, cursorPos);
      const atStart = text.lastIndexOf('@');
      const prefix = atStart >= 0 ? text.charAt(atStart - 1) : '';
      if (atStart < 0 || (prefix && !/\\s/.test(prefix)) || /\\s/.test(text.slice(atStart + 1))) {
        closeFilePicker();
        return;
      }
      filePickerAtStart = atStart;
      if (workspaceFiles.length === 0) vscode.postMessage({ command: 'requestWorkspaceFiles' });
      showFilePicker(text.slice(atStart + 1));
    }

    function showFilePicker(query) {
      filteredFiles = workspaceFiles.filter((file) => file.path.toLowerCase().includes(query.toLowerCase())).slice(0, 80);
      filePickerIndex = Math.min(filePickerIndex, Math.max(filteredFiles.length - 1, 0));
      filePicker.classList.add('show');
      renderFilePicker();
    }

    function renderFilePicker() {
      if (filteredFiles.length === 0) {
        filePickerList.innerHTML = '<div class="file-picker-empty">没有匹配的工作区文件</div>';
        return;
      }
      filePickerList.innerHTML = filteredFiles.map((file, index) =>
        '<button class="file-option' + (index === filePickerIndex ? ' active' : '') + '" role="option" data-index="' + index + '">' +
        '<span class="file-option-icon">▱</span><span class="file-option-path">' + escapeHtml(file.path) + '</span></button>'
      ).join('');
      filePickerList.querySelectorAll('.file-option').forEach((option) => {
        option.addEventListener('mousedown', (e) => e.preventDefault());
        option.addEventListener('click', () => selectFile(filteredFiles[Number(option.dataset.index)]));
      });
    }

    function selectFile(file) {
      if (!file || filePickerAtStart < 0) return;
      const cursorPos = inputEl.selectionStart;
      const before = inputEl.value.substring(0, filePickerAtStart);
      const after = inputEl.value.substring(cursorPos);
      const insert = '@' + file.path + ' ';
      inputEl.value = before + insert + after;
      inputEl.selectionStart = inputEl.selectionEnd = before.length + insert.length;
      closeFilePicker();
      inputEl.focus();
      autoResize();
    }

    function closeFilePicker() {
      filePicker.classList.remove('show');
      filePickerAtStart = -1;
    }

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
      // 重置会话名称
      sessionNameInput.value = 'Untitled';
      vscode.postMessage({ command: 'createSession', agentId: selectedAgentId });
    }

    function handleSend() {
      const text = inputEl.value.trim();
      if (!text || !currentSessionId || isStreaming) return;

      finishTurn(); // 收束上一回合，新回合从这条用户消息之后开始
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

    /** 清空消息流与所有回合级 DOM 引用。 */
    function resetConversation() {
      messagesEl.innerHTML = '';
      toolEntries.clear();
      approvalCards.clear();
      diffCards.clear();
      currentTurn = null;
      currentAssistantEl = null;
      currentAssistantTxt = '';
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderMarkdown(el, text) {
      if (typeof window.marked !== 'undefined') {
        el.innerHTML = window.marked.parse(text, { breaks: true });
      } else {
        el.textContent = text;
      }
    }

    function appendUserMsg(text) {
      clearPlaceholder();
      const row = document.createElement('div');
      row.className = 'msg-row user-row';
      const bubble = document.createElement('div');
      bubble.className = 'message user';
      bubble.textContent = text;
      row.appendChild(bubble);
      messagesEl.appendChild(row);
      scrollToBottom();
    }

    /** 回复气泡挂在当前回合尾部——因此永远排在过程时间线之后。 */
    function appendAssistantBubble(streaming) {
      const turn = ensureTurn();
      const row = document.createElement('div');
      row.className = 'msg-row';
      row.innerHTML = '<div class="msg-label">回复</div>';
      const bubble = document.createElement('div');
      bubble.className = 'message assistant' + (streaming ? ' cursor' : '');
      row.appendChild(bubble);
      turn.rootEl.appendChild(row);
      scrollToBottom();
      return bubble;
    }

    function updateAssistantMsg(chunk) {
      currentAssistantTxt += chunk;
      if (!currentAssistantEl) {
        currentAssistantEl = appendAssistantBubble(true);
      }
      renderMarkdown(currentAssistantEl, currentAssistantTxt);
      scrollToBottom();
    }

    function appendMsgFromHistory(role, text) {
      if (role === 'user') { appendUserMsg(text); return; }
      const bubble = appendAssistantBubble(false);
      renderMarkdown(bubble, text);
      finishTurn();
    }

    function showThought(text) {
      const step = document.createElement('div');
      step.className = 'step thought';
      step.innerHTML = \`
        <span class="step-dot"></span>
        <div class="step-head">
          <span class="step-icon">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a5 5 0 0 1 4.9 4.1A3.5 3.5 0 0 1 12.5 12H11v-1h1.5a2.5 2.5 0 0 0 .4-4.97A4 4 0 1 0 4 6.5a3 3 0 0 0-.5 5.97V13h1v-.5A3 3 0 0 0 7 9.5 3.5 3.5 0 0 1 8 2.5z"/>
            </svg>
          </span>
          <span class="step-name">思考</span>
        </div>
      \`;
      const body = document.createElement('div');
      body.className = 'step-body';
      body.textContent = text;
      step.appendChild(body);

      // 先夹到三行再量：夹住后仍溢出说明确实是长思考，给它一个展开开关
      step.classList.add('collapsed-text');
      addStep(step);

      if (body.scrollHeight > body.clientHeight + 4) {
        step.classList.add('clickable');
        step.querySelector('.step-head').addEventListener('click', () => {
          step.classList.toggle('collapsed-text');
        });
      } else {
        step.classList.remove('collapsed-text');
      }
    }

    function showPlan(steps) {
      const step = document.createElement('div');
      step.className = 'step plan';
      step.innerHTML = \`
        <span class="step-dot"></span>
        <div class="step-head">
          <span class="step-icon">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 3h10v1H1V3zm0 4h10v1H1V7zm0 4h7v1H1v-1zm12-7v5h1V4h-1zm0 6v3h1v-3h-1z"/>
            </svg>
          </span>
          <span class="step-name">计划</span>
        </div>
      \`;
      const ol = document.createElement('ol');
      for (const s of steps) {
        const li = document.createElement('li');
        li.textContent = s;
        ol.appendChild(li);
      }
      step.appendChild(ol);
      addStep(step);
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
            // 自动创建会话
            startNewSession();
          }
          break;
        }
        case 'sessionCreated': {
          currentSessionId = msg.sessionId;
          resetConversation();
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
          finishTurn();
          break;
        case 'toolState':
          showToolState(msg.tool, msg.state, msg.error, msg.call_id, msg.args, msg.output);
          break;
        case 'thought':
          showThought(msg.text);
          break;
        case 'plan':
          showPlan(msg.steps);
          break;
        case 'historyLoaded':
          resetConversation();
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
          scrollToBottom();
          break;
        case 'error':
          showError(msg.message);
          if (isStreaming) {
            setStreaming(false);
            if (currentAssistantEl) currentAssistantEl.classList.remove('cursor');
            currentAssistantEl = null;
            currentAssistantTxt = '';
            finishTurn();
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
        case 'workspaceFiles': {
          workspaceFiles = msg.files || [];
          if (filePickerAtStart >= 0) {
            const cursorPos = inputEl.selectionStart;
            const text = inputEl.value.substring(0, cursorPos);
            showFilePicker(text.slice(filePickerAtStart + 1));
          }
          break;
        }
        case 'historyList': {
          // 简单实现：如果有会话则切换加载
          const sessions = msg.sessions || [];
          if (sessions.length === 0) {
            showError('暂无历史会话');
          } else {
            // 简化版：加载最近的会话
            const latest = sessions[0];
            if (latest && latest.session_id) {
              currentSessionId = latest.session_id;
              sessionNameInput.value = latest.name || 'Untitled';
              vscode.postMessage({ command: 'loadHistory', sessionId: currentSessionId });
            }
          }
          break;
        }
      }
    });

    // init
    vscode.postMessage({ command: 'requestAgents' });
`;
  }
}
