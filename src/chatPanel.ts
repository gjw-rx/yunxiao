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

export class ChatViewProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private readonly _client: AIClient;
	private readonly _registry: ToolRegistry;
	private readonly _sessionManager: SessionManager;
	private readonly _eventBus: EventBus;
	private _baseUrl: string;
	private _configListener?: vscode.Disposable;
	private _currentSessionId?: string;

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
				const p = e.payload as { call_id: string; state: string; tool: string; error?: string };
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
    :root {
      --bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
      --fg: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground));
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border, transparent);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --btn-secondary-bg: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
      --btn-secondary-fg: var(--vscode-button-secondaryForeground, var(--vscode-input-foreground));
      --font: var(--vscode-font-family);
      --font-size: var(--vscode-font-size, 13px);
      --mono: var(--vscode-editor-font-family);
      --border: var(--vscode-panel-border, rgba(128,128,128,0.2));
      --radius: 6px;
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
    }

    /* ── Header / Agent selector ── */
    #header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    #agentSelect {
      flex: 1;
      min-width: 0;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      padding: 5px 7px;
      border-radius: var(--radius);
      font-family: var(--font);
      font-size: 12px;
      outline: none;
      cursor: pointer;
    }
    #agentSelect:focus { border-color: var(--vscode-focusBorder); }

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
    .btn-icon:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15));
    }

    .btn-stop {
      padding: 4px 8px;
      background: var(--vscode-inputValidation-errorBackground, #c72e2e);
      color: #fff;
    }
    .btn-stop:hover:not(:disabled) { opacity: 0.85; }

    /* ── Message list ── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 10px 10px 4px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    #messages::-webkit-scrollbar { width: 4px; }
    #messages::-webkit-scrollbar-thumb {
      background: rgba(128,128,128,0.3);
      border-radius: 2px;
    }

    .placeholder {
      text-align: center;
      color: var(--vscode-descriptionForeground, rgba(128,128,128,0.6));
      margin: auto;
      font-size: 12px;
      line-height: 1.7;
      padding: 20px 10px;
    }
    .placeholder svg { opacity: 0.4; margin-bottom: 8px; }

    .msg-row {
      display: flex;
      flex-direction: column;
      max-width: 100%;
      margin-bottom: 6px;
    }

    .msg-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground, rgba(128,128,128,0.6));
      margin-bottom: 3px;
      padding: 0 2px;
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
      padding: 7px 12px;
      border-radius: 12px 12px 2px 12px;
      white-space: pre-wrap;
      max-width: 88%;
    }

    .message.assistant {
      align-self: flex-start;
      padding: 2px 0;
      max-width: 100%;
    }

    /* Markdown */
    .message.assistant p { margin: 0 0 6px; }
    .message.assistant p:last-child { margin-bottom: 0; }
    .message.assistant pre {
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.12));
      padding: 8px 12px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 4px 0;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.5;
    }
    .message.assistant code {
      font-family: var(--mono);
      font-size: 0.88em;
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.12));
      padding: 1px 4px;
      border-radius: 3px;
    }
    .message.assistant pre code { background: none; padding: 0; }
    .message.assistant ul,
    .message.assistant ol { padding-left: 18px; margin: 4px 0; }
    .message.assistant li { margin: 1px 0; }
    .message.assistant a { color: var(--vscode-textLink-foreground); }
    .message.assistant blockquote {
      border-left: 3px solid var(--vscode-textBlockQuote-border, rgba(128,128,128,0.4));
      padding-left: 10px;
      margin: 4px 0;
      opacity: 0.8;
    }
    .message.assistant h1,
    .message.assistant h2,
    .message.assistant h3 { margin: 8px 0 4px; font-size: 1em; }
    .message.assistant table {
      border-collapse: collapse;
      margin: 6px 0;
      font-size: 12px;
      width: 100%;
    }
    .message.assistant th,
    .message.assistant td {
      border: 1px solid var(--border);
      padding: 4px 8px;
    }
    .message.assistant th {
      background: rgba(128,128,128,0.1);
      font-weight: 600;
    }

    /* streaming cursor */
    .cursor::after {
      content: '▋';
      animation: blink 0.9s step-start infinite;
      opacity: 0.7;
    }
    @keyframes blink { 50% { opacity: 0; } }

    /* ── Tool state / thought / plan ── */
    .message.tool-state {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--vscode-descriptionForeground, rgba(128,128,128,0.85));
      padding: 3px 6px;
      align-self: flex-start;
      max-width: 100%;
    }
    .message.tool-state.pending,
    .message.tool-state.running { color: var(--vscode-textLink-foreground, #4aa3ff); }
    .message.tool-state.success { color: var(--vscode-testing-iconPassed, #3fb950); }
    .message.tool-state.error { color: var(--vscode-errorForeground, #f55); }
    .message.thought {
      font-style: italic;
      opacity: 0.7;
      font-size: 12px;
      align-self: flex-start;
      padding: 2px 6px;
    }
    .message.plan {
      align-self: flex-start;
      font-size: 12px;
      padding: 2px 6px;
    }
    .message.plan ol { padding-left: 18px; }

    /* ── Error bar ── */
    #error {
      padding: 6px 10px;
      color: var(--vscode-errorForeground, #f55);
      font-size: 11px;
      flex-shrink: 0;
      border-top: 1px solid transparent;
    }
    #error:not(:empty) { border-color: var(--border); }
    #error:empty { display: none; }

    /* ── Input area ── */
    #inputArea {
      padding: 8px 10px;
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
      transition: border-color 0.12s, box-shadow 0.12s;
    }
    #inputWrapper:focus-within {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }

    #input {
      flex: 1;
      background: transparent;
      color: var(--input-fg);
      border: none;
      padding: 2px 0;
      font-family: var(--font);
      font-size: 13px;
      line-height: 1.5;
      resize: none;
      min-height: 22px;
      max-height: 110px;
      outline: none;
    }
    #input::placeholder {
      color: var(--vscode-input-placeholderForeground, rgba(128,128,128,0.6));
    }
    #input:disabled { cursor: not-allowed; }

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
      color: var(--vscode-descriptionForeground, rgba(128,128,128,0.45));
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div id="header">
    <select id="agentSelect"><option value="">加载中...</option></select>
    <button id="newSessionBtn" class="btn" title="新建会话">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm1 10H7V9H5V7h2V5h2v2h2v2H9v2z"/>
      </svg>
      新会话
    </button>
  </div>

  <div id="messages">
    <div class="placeholder">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style="display:block;margin:0 auto 8px">
        <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/>
      </svg>
      选择 Agent 并点击「新会话」<br>开始对话
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
      <button id="stopBtn" class="btn btn-stop" disabled style="display:none" title="停止">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <rect x="1" y="1" width="8" height="8" rx="1"/>
        </svg>
      </button>
    </div>
    <div id="hint">Enter 发送 &middot; Shift+Enter 换行</div>
  </div>

  <script nonce="${nonce}" src="${markedUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const messagesEl  = document.getElementById('messages');
    const inputEl     = document.getElementById('input');
    const sendBtn     = document.getElementById('sendBtn');
    const stopBtn     = document.getElementById('stopBtn');
    const newSessBtn  = document.getElementById('newSessionBtn');
    const agentSelect = document.getElementById('agentSelect');
    const errorEl     = document.getElementById('error');

    let currentSessionId   = null;
    let isStreaming         = false;
    let currentAssistantEl  = null;
    let currentAssistantTxt = '';

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
      inputEl.style.height = Math.min(inputEl.scrollHeight, 110) + 'px';
    }

    function startNewSession() {
      const agentId = agentSelect.value;
      if (!agentId) { showError('请先选择一个 Agent'); return; }
      vscode.postMessage({ command: 'createSession', agentId });
    }

    function handleSend() {
      const text = inputEl.value.trim();
      if (!text || !currentSessionId || isStreaming) return;

      appendUserMsg(text);
      inputEl.value = '';
      autoResize();
      setStreaming(true);
      currentAssistantTxt = '';
      currentAssistantEl  = null;

      vscode.postMessage({ command: 'sendMessage', sessionId: currentSessionId, text });
    }

    // ── Rendering ──

    function clearPlaceholder() {
      const p = messagesEl.querySelector('.placeholder');
      if (p) p.remove();
    }

    function appendUserMsg(text) {
      clearPlaceholder();
      const row = document.createElement('div');
      row.className = 'msg-row';
      row.innerHTML = '<div class="msg-label" style="text-align:right">你</div>';
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

    function showError(msg) {
      errorEl.textContent = msg;
      setTimeout(() => { if (errorEl.textContent === msg) errorEl.textContent = ''; }, 5000);
    }

    const toolRows = new Map();
    function showToolState(tool, state, error, callId) {
      clearPlaceholder();
      let row = toolRows.get(callId);
      if (!row) {
        row = document.createElement('div');
        row.className = 'msg-row';
        const label = document.createElement('div');
        label.className = 'msg-label';
        label.textContent = '工具';
        const bubble = document.createElement('div');
        bubble.className = 'message tool-state ' + state;
        row.appendChild(label);
        row.appendChild(bubble);
        messagesEl.appendChild(row);
        toolRows.set(callId, row);
      }
      const bubble = row.querySelector('.tool-state');
      const icon = state === 'success' ? '✔' : state === 'error' ? '✘' : '⚙';
      bubble.className = 'message tool-state ' + state;
      bubble.textContent = icon + ' ' + tool + ' · ' + state + (error ? ' · ' + error : '');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function showThought(text) {
      clearPlaceholder();
      const row = document.createElement('div');
      row.className = 'msg-row';
      const label = document.createElement('div');
      label.className = 'msg-label';
      label.textContent = '思考';
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
      label.textContent = '计划';
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

    function setStreaming(state) {
      isStreaming = state;
      sendBtn.style.display = state ? 'none' : 'inline-flex';
      stopBtn.style.display = state ? 'inline-flex' : 'none';
      stopBtn.disabled = !state;
      sendBtn.disabled = state || !currentSessionId;
      inputEl.disabled = !currentSessionId;
    }

    // ── Host messages ──

    window.addEventListener('message', (e) => {
      const msg = e.data;
      switch (msg.command) {
        case 'agentsLoaded': {
          agentSelect.innerHTML = '<option value="">-- 选择 Agent --</option>';
          for (const a of msg.agents) {
            const opt = document.createElement('option');
            opt.value = a.agent_id;
            opt.textContent = a.agent_name + (a.model ? ' (' + a.model + ')' : '');
            agentSelect.appendChild(opt);
          }
          break;
        }
        case 'sessionCreated': {
          currentSessionId = msg.sessionId;
          messagesEl.innerHTML = '';
          toolRows.clear();
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
          currentAssistantEl  = null;
          currentAssistantTxt = '';
          break;
        case 'toolState':
          showToolState(msg.tool, msg.state, msg.error, msg.call_id);
          break;
        case 'thought':
          showThought(msg.text);
          break;
        case 'plan':
          showPlan(msg.steps);
          break;
        case 'historyLoaded':
          messagesEl.innerHTML = '';
          if (msg.messages.length === 0) {
            messagesEl.innerHTML = '<div class="placeholder">会话已创建，发送第一条消息吧</div>';
          }
          for (const m of msg.messages) appendMsgFromHistory(m.role, m.content);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        case 'error':
          showError(msg.message);
          if (isStreaming) {
            setStreaming(false);
            if (currentAssistantEl) currentAssistantEl.classList.remove('cursor');
            currentAssistantEl  = null;
            currentAssistantTxt = '';
          }
          break;
        // 来自工具栏按钮的触发
        case 'triggerNewSession':
          startNewSession();
          break;
      }
    });

    // init
    vscode.postMessage({ command: 'requestAgents' });
  </script>
</body>
</html>`;
	}
}
