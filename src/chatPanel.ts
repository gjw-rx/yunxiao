import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { ToolRegistry } from './core/toolRegistry';
import type { EventBus, AgentEvent } from './core/eventBus';
import type { LocalSessionManager } from './core/localSessionManager';
import { DEFAULT_MAX_FILE_SIZE, isBinaryExt, redactSecrets } from './tools/fs/readFile';
import * as logger from './logger';

interface ChatViewDeps {
  readonly sessionManager: LocalSessionManager;
  readonly registry: ToolRegistry;
  readonly eventBus: EventBus;
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
  private readonly _registry: ToolRegistry;
  private readonly _sessionManager: LocalSessionManager;
  private readonly _eventBus: EventBus;
  private _currentSessionId?: string;
  private _createSessionRequest = 0;
  private readonly _pendingApprovals = new Map<string, ApprovalResolver>();
  private readonly _sessionNames = new Map<string, string>();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    deps: ChatViewDeps
  ) {
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

    // 订阅事件总线，将当前会话的事件转发给 webview
    const unsub = this._eventBus.onAll((e) => this._forwardEvent(e));
    this._context.subscriptions.push({ dispose: unsub });

    // 发送当前模型名称到 webview
    const modelConfig = vscode.workspace.getConfiguration('yunxiaoAgent.model');
    const modelName = modelConfig.get<string>('model', '');
    if (modelName) {
      webviewView.webview.postMessage({ command: 'modelInfo', model: modelName });
    }
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
      case 'step_end':
        view.webview.postMessage({ command: 'stepEnd' });
        break;
      case 'token_usage':
        view.webview.postMessage({ command: 'tokenUsage', payload: e.payload });
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
        // code.edit 成功且有 diff 数据时，额外发送 diffResult 命令
        if (p.tool === 'code.edit' && p.state === 'success' && p.output) {
          const out = p.output as Record<string, unknown>;
          if (out.diff) {
            view.webview.postMessage({
              command: 'diffResult',
              call_id: p.call_id,
              file_path: out.file_path ?? out.path ?? '',
              diff_html: out.diff_html ?? out.diff ?? '',
              additions: out.additions ?? 0,
              deletions: out.deletions ?? 0,
            });
          }
        }
        break;
      }
      case 'tool_call': {
        const p = e.payload as { call_id: string; tool: string; args?: unknown };
        view.webview.postMessage({ command: 'toolCall', ...p });
        break;
      }
      case 'tool_result': {
        const p = e.payload as { call_id: string; status: string; result?: unknown; error?: string };
        view.webview.postMessage({ command: 'toolResult', ...p });
        break;
      }
      case 'thought':
        view.webview.postMessage({ command: 'thought', text: e.payload as string });
        break;
      case 'progress': {
        const p = e.payload as { phase?: string };
        view.webview.postMessage({ command: 'progress', phase: p.phase });
        break;
      }
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

  /** 获取当前会话 ID */
  getCurrentSessionId(): string | undefined {
    return this._currentSessionId;
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

    logger.log(`[ChatPanel] 收到 webview 消息: ${msg.command}`);

    switch (msg.command) {
      case 'createSession': {
        const requestId = ++this._createSessionRequest;
        const previousSessionId = this._currentSessionId;
        if (previousSessionId) {
          this._sessionManager.reset(previousSessionId);
        }
        const sessionId = this._sessionManager.createSession();
        if (requestId !== this._createSessionRequest) {
          break;
        }
        this._currentSessionId = sessionId;
        view.webview.postMessage({ command: 'sessionCreated', sessionId });
        break;
      }
      case 'sendMessage': {
        const sessionId = msg.sessionId as string;
        const userText = (msg.text as string) ?? '';
        const files = Array.isArray(msg.files)
          ? (msg.files as { path: string }[])
          : [];
        // 读取引用文件内容，拼接为结构化上下文前置到用户文本（见 _buildFileContext）
        let text = userText;
        if (files.length > 0) {
          const contextBlock = await this._buildFileContext(files);
          text = userText ? `${contextBlock}\n\n${userText}` : contextBlock;
        }
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
        const history = this._sessionManager.loadHistory(msg.sessionId as string);
        view.webview.postMessage({ command: 'historyLoaded', messages: history });
        break;
      }
      case 'approvalDecision': {
        const callId = msg.call_id as string;
        const decision = msg.decision as 'allow' | 'always' | 'deny';
        const resolver = this._pendingApprovals.get(callId);
        if (resolver) {
          this._pendingApprovals.delete(callId);
          resolver(decision);
        } else {
          logger.error(`[ChatPanel] 审批回调未找到 call_id=${callId}`);
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
    }
  }

  /**
   * 将引用文件内容拼接为结构化上下文块，供模型直接获取文件内容而非裸路径。
   * 路径解析与 requestWorkspaceFiles 生成 displayPath 的逻辑对称（多工作区带 folderName/ 前缀）。
   * 读取失败的文件以 error 属性标注注入上下文，并弹窗告知用户，避免模型盲目搜索不存在的文件。
   */
  private async _buildFileContext(files: { path: string }[]): Promise<string> {
    const parts: string[] = [];
    const failed: string[] = [];
    for (const file of files) {
      const result = await this._readReferencedFile(file.path);
      if (result.ok) {
        parts.push(`<file path="${file.path}">\n${result.content}\n</file>`);
      } else {
        parts.push(`<file path="${file.path}" error="${result.reason}"></file>`);
        failed.push(`${file.path}(${result.reason})`);
      }
    }
    if (failed.length > 0) {
      void vscode.window.showWarningMessage(
        `以下引用文件无法读取，已作为不可读引用告知模型，请确认路径是否正确：\n${failed.join('\n')}`
      );
    }
    return `<referenced_files>\n${parts.join('\n')}\n</referenced_files>`;
  }

  /** 读取单个引用文件内容，复用 read_file 的安全策略（大小限制/二进制检测/敏感脱敏）。失败返回原因。 */
  private async _readReferencedFile(
    displayPath: string
  ): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return { ok: false, reason: '未找到工作区' };
    }
    // 反解 displayPath 为绝对路径（与 requestWorkspaceFiles 生成逻辑对称）
    let absPath: string | undefined;
    for (const folder of folders) {
      const prefix = folder.name + '/';
      if (displayPath.startsWith(prefix)) {
        absPath = path.join(folder.uri.fsPath, displayPath.slice(prefix.length));
        break;
      }
    }
    if (!absPath) {
      absPath = path.join(folders[0].uri.fsPath, displayPath);
    }
    try {
      const stat = await fs.stat(absPath);
      if (stat.size > DEFAULT_MAX_FILE_SIZE) {
        return { ok: false, reason: '文件超过大小上限' };
      }
      if (isBinaryExt(absPath)) {
        return { ok: false, reason: '二进制文件' };
      }
      const content = await fs.readFile(absPath, 'utf8');
      if (content.includes('\0')) {
        return { ok: false, reason: '二进制文件' };
      }
      return { ok: true, content: redactSecrets(content) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      return { ok: false, reason: code === 'ENOENT' ? '文件不存在' : '无法读取' };
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
      --bg: #f7f8fa;
      --fg: #20252d;
      --input-bg: #ffffff;
      --input-fg: #20252d;
      --input-border: #e4e7ec;
      --input-placeholder: #9aa1ad;
      --btn-bg: #176b5e;
      --btn-fg: #ffffff;
      --btn-hover: #12584d;
      --btn-secondary-bg: #ffffff;
      --btn-secondary-fg: #20252d;
      --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      --font-size: var(--vscode-font-size, 13px);
      --mono: var(--vscode-editor-font-family, 'SF Mono', Monaco, Menlo, Consolas, monospace);
      --border: #e4e7ec;
      --border-light: #eef0f3;
      --radius: 6px;
      --radius-lg: 8px;
      --accent: #176b5e;
      /* 时间线轨道与步骤节点 */
      --rail: color-mix(in srgb, var(--fg) 16%, transparent);
      --rail-active: var(--accent);
      --step-bg: color-mix(in srgb, var(--fg) 4%, transparent);
      --step-bg-hover: color-mix(in srgb, var(--fg) 8%, transparent);
      --label-tracking: 0.08em;
      --success: var(--vscode-testing-iconPassed, #3fb950);
      --error: var(--vscode-errorForeground, #f85149);
      --warning: var(--vscode-editorWarning-foreground, #d29922);
      --muted: #7b8491;
      --hover-bg: #f1f5f4;
      --focus: #4ba998;
      --code-bg: #f3f5f7;
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

    /* ── Model info display ── */
    .model-info {
      flex: 1;
      min-width: 0;
      padding: 4px 8px;
      font-size: 12px;
      font-weight: 500;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
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
      width: 100%;
      min-width: 0;
      font-size: 12px;
      line-height: 1.6;
      color: var(--muted);
      padding: 1px 0 5px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
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
      background: #ffffff;
    }

    #filePicker, #slashCommandPicker {
      position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); display: none;
      overflow: hidden; background: var(--vscode-quickInput-background, var(--vscode-editor-background, #252526));
      border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 30px rgba(0,0,0,0.28); z-index: 110;
      animation: picker-rise 0.14s ease-out both;
    }
    #filePicker.show, #slashCommandPicker.show { display: block; }
    .file-picker-heading { display: flex; justify-content: space-between; padding: 8px 10px 6px; color: var(--muted); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; }
    .file-picker-hint { opacity: 0.7; text-transform: none; letter-spacing: 0; }
    #filePickerList { max-height: 220px; overflow-y: auto; padding: 0 4px 4px; }
    .file-option { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--fg); cursor: pointer; text-align: left; font: inherit; }
    .file-option:hover, .file-option.active { background: var(--vscode-list-activeSelectionBackground, var(--hover-bg)); color: var(--vscode-list-activeSelectionForeground, var(--fg)); }
    .file-option-icon { color: var(--muted); flex: 0 0 auto; }
    .file-option-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .file-picker-empty { padding: 12px 10px; color: var(--muted); font-size: 12px; }
    #slashCommandList { padding: 0 4px 4px; }
    .slash-command-option {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: var(--fg);
      cursor: pointer;
      text-align: left;
      font: inherit;
    }
    .slash-command-option:hover, .slash-command-option.active {
      color: var(--vscode-list-activeSelectionForeground, var(--fg));
      background: var(--vscode-list-activeSelectionBackground, var(--hover-bg));
    }
    .slash-command-icon {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border: 1px solid var(--border-light);
      border-radius: 6px;
      color: var(--accent);
      font-family: var(--mono);
      font-weight: 700;
    }
    .slash-command-copy { min-width: 0; }
    .slash-command-name { display: block; font-family: var(--mono); font-size: 12px; font-weight: 600; }
    .slash-command-description { display: block; margin-top: 2px; color: var(--muted); font-size: 10px; }
    .slash-command-key { color: var(--muted); font-size: 9px; }
    @keyframes picker-rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    #inputWrapper {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      background: #ffffff;
      border: 1px solid var(--input-border);
      border-radius: 10px;
      padding: 8px 10px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    #inputWrapper:focus-within {
      border-color: var(--focus);
      box-shadow: 0 0 0 1px var(--focus);
    }

    .file-reference-list {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .file-reference-list:empty { display: none; }
    .file-reference-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 100%;
      height: 24px;
      padding: 0 3px 0 5px;
      border: 1px solid var(--border-light);
      border-radius: 5px;
      color: var(--input-fg);
      background: var(--vscode-editor-background, #ffffff);
      font: inherit;
      transition: border-color 0.15s, background 0.15s;
    }
    .file-reference-chip:hover {
      border-color: var(--input-border);
      background: var(--hover-bg);
    }
    .file-reference-extension {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      min-width: 17px;
      height: 16px;
      padding: 0 2px;
      border-radius: 3px;
      color: var(--vscode-editor-background, #ffffff);
      background: var(--accent);
      font-family: var(--mono);
      font-size: 8px;
      font-weight: 700;
      line-height: 1;
      text-transform: uppercase;
    }
    .file-reference-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
      line-height: 1;
    }
    .file-reference-remove {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      margin-left: 1px;
      padding: 0;
      border: 0;
      border-radius: 3px;
      color: var(--muted);
      background: transparent;
      cursor: pointer;
      font-family: var(--font);
      font-size: 14px;
      line-height: 1;
      transition: color 0.15s, background 0.15s;
    }
    .file-reference-remove:hover {
      color: var(--error);
      background: color-mix(in srgb, var(--error) 10%, transparent);
    }
    .file-reference-remove:focus-visible {
      outline: 1px solid var(--focus);
      outline-offset: 1px;
    }

    #input {
      flex: 1;
      width: 100%;
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
      padding: 8px 2px 0;
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

    .chevron {
      width: 12px;
      height: 12px;
      flex-shrink: 0;
      transition: transform 0.2s;
      color: var(--muted);
    }

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
    }

    /* ── Message action bar ── */
    .msg-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 2px;
      margin-top: 6px;
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .msg-row:hover .msg-actions,
    .msg-row:focus-within .msg-actions {
      opacity: 1;
    }

    .msg-action-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      height: 26px;
      padding: 0 8px;
      border: none;
      background: transparent;
      color: var(--muted);
      border-radius: 6px;
      cursor: pointer;
      font-family: var(--font);
      font-size: 11px;
      transition: all 0.12s ease;
    }
    .msg-action-btn:hover:not(:disabled) {
      background: var(--hover-bg);
      color: var(--fg);
    }
    .msg-action-btn:active:not(:disabled) {
      transform: scale(0.95);
    }
    .msg-action-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .msg-action-btn svg {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
    }
    .msg-action-btn.liked {
      color: var(--accent);
    }
    .msg-action-btn.liked svg {
      fill: currentColor;
    }

    /* ── User message hover state ── */
    .msg-row.user-row .message.user {
      transition: border-color 0.15s, background 0.15s;
    }
    .msg-row.user-row:hover .message.user {
      border-color: var(--input-border);
      background: var(--hover-bg);
    }

    /* ── Delete action button ── */
    .msg-action-btn.delete-btn:hover:not(:disabled) {
      color: var(--error);
      background: color-mix(in srgb, var(--error) 10%, transparent);
    }

    .token-usage {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 0 8px;
      font-family: var(--mono);
      font-size: 10px;
      color: var(--muted);
      user-select: none;
    }
    .token-usage svg {
      width: 12px;
      height: 12px;
      opacity: 0.7;
      flex-shrink: 0;
    }
    .token-progress {
      display: inline-block;
      width: 24px;
      height: 3px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--vscode-progressBar-background, var(--border));
      opacity: 0.35;
    }
    .token-progress-fill {
      display: block;
      width: 0;
      height: 100%;
      border-radius: inherit;
      background: var(--accent);
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
    <div id="slashCommandPicker" role="listbox" aria-label="选择 Slash 命令">
      <div class="file-picker-heading"><span>Slash 命令</span><span class="file-picker-hint">↑↓ 选择 · Enter 执行 · Esc 关闭</span></div>
      <div id="slashCommandList"></div>
    </div>
    <div id="filePicker" role="listbox" aria-label="选择工作区文件">
      <div class="file-picker-heading"><span>工作区文件</span><span class="file-picker-hint">↑↓ 选择 · Enter 确认 · Esc 关闭</span></div>
      <div id="filePickerList"></div>
    </div>
    <div id="inputWrapper">
      <div id="fileReferenceList" class="file-reference-list" aria-label="已引用文件"></div>
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
        <div class="model-info">
          <span id="modelName">--</span>
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
    <div id="hint">Enter 发送 &middot; Shift+Enter 换行 &middot; 中文输入法下 Enter 确认候选词 &middot; / 命令 &middot; @ 引用文件</div>
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
    const sessionNameInput = document.getElementById('sessionNameInput');
    const errorEl      = document.getElementById('error');
    const filePicker   = document.getElementById('filePicker');
    const filePickerList = document.getElementById('filePickerList');
    const fileReferenceList = document.getElementById('fileReferenceList');
    const slashCommandPicker = document.getElementById('slashCommandPicker');
    const slashCommandList = document.getElementById('slashCommandList');

    // ── State ──
    let currentSessionId = null;
    let isStreaming = false;
    let workspaceFiles = [];
    let filePickerIndex = 0;
    let filePickerAtStart = -1;
    let filteredFiles = [];
    let selectedFiles = [];
    let slashCommandIndex = 0;
    let filteredSlashCommands = [];
    const slashCommands = [];

    /* 「回合」模型：一轮对话 = 过程时间线（思考/工具/审批）+ 最终回复。
       时间线容器先于回复气泡插入 DOM，因此过程天然呈现在回复之上。 */
    let currentTurn = null;        // { rootEl, traceEl, traceBodyEl, countEl, liveEl, stepCount }
    let currentAssistantEl = null; // 当前流式回复气泡
    let currentAssistantRow = null; // 当前流式回复消息行（包含操作栏）
    let currentAssistantTxt = '';
    let currentThoughtEl = null;
    let currentThoughtTxt = '';
    const toolEntries = new Map();   // call_id -> { stepEl, detailEl, state, tool }
    const approvalCards = new Map(); // call_id -> card element
    const diffCards = new Map();     // call_id -> card element

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

    document.addEventListener('click', (e) => {
      if (!filePicker.contains(e.target) && e.target !== inputEl) {
        closeFilePicker();
      }
      if (!slashCommandPicker.contains(e.target) && e.target !== inputEl) {
        closeSlashCommandPicker();
      }
    });

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
      smartScrollToBottom();
      return turn;
    }

    /** 回合收尾：停掉 live 指示灯，过程默认折叠，让最终回复成为焦点。 */
    function finishTurn() {
      if (!currentTurn) return;
      if (currentTurn.liveEl) currentTurn.liveEl.style.display = 'none';
      if (currentTurn.stepCount > 0) currentTurn.traceEl.classList.add('collapsed');
      currentTurn = null;
      currentThoughtEl = null;
      currentThoughtTxt = '';
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

        entry = {
          stepEl: step,
          detailEl: detail,
          state,
          tool,
          args: undefined,
          output: undefined,
          error: undefined,
        };
        toolEntries.set(callId, entry);
        addStep(step);
      }

      // 状态推进：保留展开态
      entry.state = state;
      entry.args = args !== undefined && args !== null ? args : entry.args;
      entry.output = output !== undefined && output !== null ? output : entry.output;
      entry.error = error || entry.error;
      const wasExpanded = entry.stepEl.classList.contains('expanded');
      entry.stepEl.className =
        'step tool clickable ' + state + (wasExpanded ? ' expanded' : '');
      entry.stepEl.querySelector('.step-status').innerHTML = getStatusIcon(state);

      const argPreview = summarizeArgs(entry.args);
      if (argPreview) {
        entry.stepEl.querySelector('.step-arg').textContent = argPreview;
      }

      let html = '';
      if (entry.args !== undefined && entry.args !== null) {
        html += \`<div class="detail-label">参数</div><div class="detail-block">\${escapeHtml(truncate(stringify(entry.args), 1200))}</div>\`;
      }
      if (entry.error) {
        html += \`<div class="detail-label">错误</div><div class="detail-block is-error">\${escapeHtml(entry.error)}</div>\`;
      } else if (entry.output !== undefined && entry.output !== null) {
        html += \`<div class="detail-label">结果</div><div class="detail-block">\${escapeHtml(truncate(stringify(entry.output), 2000))}</div>\`;
      }
      entry.detailEl.innerHTML = html;

      smartScrollToBottom();
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

      smartScrollToBottom();
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
      smartScrollToBottom();
    }

    // ── Utility ──
    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      const div = document.createElement('div');
      div.textContent = String(str);
      return div.innerHTML;
    }

    function escapeAttribute(str) {
      return escapeHtml(str).replace(/"/g, '&quot;');
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
      if (slashCommandPicker.classList.contains('show')) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (filteredSlashCommands.length === 0) return;
          slashCommandIndex = (
            slashCommandIndex
            + (e.key === 'ArrowDown' ? 1 : -1)
            + filteredSlashCommands.length
          ) % filteredSlashCommands.length;
          renderSlashCommands();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          selectSlashCommand(filteredSlashCommands[slashCommandIndex]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeSlashCommandPicker();
          return;
        }
      }
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
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleSend(); }
    });

    inputEl.addEventListener('input', autoResize);
    inputEl.addEventListener('input', handleSlashTrigger);

    // ── Slash 命令选择 ──
    function handleSlashTrigger() {
      const cursorPos = inputEl.selectionStart;
      const text = inputEl.value;
      const commandText = text.substring(0, cursorPos);
      if (
        cursorPos !== text.length
        || !commandText.startsWith('/')
        || /\\s/.test(commandText)
      ) {
        closeSlashCommandPicker();
        return;
      }

      const query = commandText.slice(1).toLowerCase();
      filteredSlashCommands = slashCommands.filter((command) =>
        command.command.startsWith(query)
      );
      if (filteredSlashCommands.length === 0) {
        closeSlashCommandPicker();
        return;
      }

      closeFilePicker();
      slashCommandIndex = Math.min(
        slashCommandIndex,
        filteredSlashCommands.length - 1,
      );
      slashCommandPicker.classList.add('show');
      renderSlashCommands();
    }

    function renderSlashCommands() {
      slashCommandList.innerHTML = filteredSlashCommands.map((command, index) =>
        '<button class="slash-command-option' + (index === slashCommandIndex ? ' active' : '') +
        '" role="option" data-index="' + index + '">' +
        '<span class="slash-command-icon">/</span>' +
        '<span class="slash-command-copy"><span class="slash-command-name">' +
        escapeHtml(command.label) + '</span><span class="slash-command-description">' +
        escapeHtml(command.description) + '</span></span>' +
        '<span class="slash-command-key">Enter</span></button>'
      ).join('');
      slashCommandList.querySelectorAll('.slash-command-option').forEach((option) => {
        option.addEventListener('mousedown', (e) => e.preventDefault());
        option.addEventListener('click', () => {
          selectSlashCommand(filteredSlashCommands[Number(option.dataset.index)]);
        });
      });
    }

    function selectSlashCommand(command) {
      if (!command) return;
      inputEl.value = '';
      autoResize();
      closeSlashCommandPicker();
    }

    function closeSlashCommandPicker() {
      slashCommandPicker.classList.remove('show');
      filteredSlashCommands = [];
      slashCommandIndex = 0;
    }

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
      closeSlashCommandPicker();
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
      inputEl.value = before + after;
      inputEl.selectionStart = inputEl.selectionEnd = before.length;
      if (!selectedFiles.some((selected) => selected.path === file.path)) {
        selectedFiles.push(file);
      }
      renderFileReferences();
      closeFilePicker();
      inputEl.focus();
      autoResize();
    }

    function renderFileReferences() {
      fileReferenceList.innerHTML = selectedFiles.map((file, index) => {
        const extension = file.name.includes('.')
          ? file.name.split('.').pop().slice(0, 3)
          : 'file';
        return '<span class="file-reference-chip" title="' + escapeAttribute(file.path) + '">' +
          '<span class="file-reference-extension">' + escapeHtml(extension) + '</span>' +
          '<span class="file-reference-name">' + escapeHtml(file.name) + '</span>' +
          '<button type="button" class="file-reference-remove" data-index="' + index +
          '" aria-label="取消引用 ' + escapeAttribute(file.name) + '" title="取消引用">&times;</button></span>';
      }).join('');
      fileReferenceList.querySelectorAll('.file-reference-remove').forEach((button) => {
        button.addEventListener('click', () => {
          selectedFiles.splice(Number(button.dataset.index), 1);
          renderFileReferences();
          inputEl.focus();
        });
      });
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
      sessionNameInput.value = 'Untitled';
      vscode.postMessage({ command: 'createSession' });
    }

    function handleSend() {
      const userText = inputEl.value.trim();
      const files = selectedFiles.slice();
      if ((!userText && files.length === 0) || !currentSessionId || isStreaming) return;

      finishTurn(); // 收束上一回合，新回合从这条用户消息之后开始
      // 用户气泡展示引用文件（纯文本提示，不含 @ 符号，避免污染工具调用路径）
      const displayParts = [];
      if (files.length > 0) {
        displayParts.push('引用文件: ' + files.map((file) => file.path).join(', '));
      }
      if (userText) {
        displayParts.push(userText);
      }
      appendUserMsg(displayParts.join('\\n'));
      inputEl.value = '';
      selectedFiles = [];
      renderFileReferences();
      autoResize();
      setStreaming(true);
      currentAssistantTxt = '';
      currentAssistantEl = null;
      currentAssistantRow = null;

      // 文件引用作为独立字段传递，由扩展主进程读取内容注入结构化上下文
      vscode.postMessage({ command: 'sendMessage', sessionId: currentSessionId, text: userText, files });
    }

    // ── Message rendering ──
    function clearPlaceholder() {
      const p = messagesEl.querySelector('.placeholder');
      if (p) p.remove();
    }

    /** 清空消息流与所有回合级 DOM 引用。 */
    function resetConversation() {
      messagesEl.innerHTML = '';
      selectedFiles = [];
      renderFileReferences();
      toolEntries.clear();
      approvalCards.clear();
      diffCards.clear();
      currentTurn = null;
      currentAssistantEl = null;
      currentAssistantRow = null;
      currentAssistantTxt = '';
      currentThoughtEl = null;
      userTurnCount = 0;
      currentThoughtTxt = '';
    }

    /** 判断用户是否在底部附近（用于流式输出时决定是否自动跟随） */
    function isNearBottom() {
      const threshold = 80;
      return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
    }

    /** 用户手动滚动时记录位置，阻止流式自动跟随 */
    let userScrolledAway = false;
    messagesEl.addEventListener('scroll', () => {
      if (isNearBottom()) {
        userScrolledAway = false;
      } else if (isStreaming) {
        userScrolledAway = true;
      }
    });

    /** 强制滚动到底部（用户消息、新会话等非流式场景） */
    function scrollToBottom() {
      userScrolledAway = false;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    /** 流式输出期间智能滚动：仅当用户未手动上滑时跟随 */
    function smartScrollToBottom() {
      if (!userScrolledAway) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    function renderMarkdown(el, text) {
      if (typeof window.marked !== 'undefined') {
        el.innerHTML = window.marked.parse(text, { breaks: true });
      } else {
        el.textContent = text;
      }
    }

    /** 用户消息轮次计数器（1-based） */
    let userTurnCount = 0;

    function appendUserMsg(text) {
      clearPlaceholder();
      userTurnCount++;
      const row = document.createElement('div');
      row.className = 'msg-row user-row';
      row.dataset.turn = String(userTurnCount);
      const bubble = document.createElement('div');
      bubble.className = 'message user';
      bubble.textContent = text;
      row.appendChild(bubble);

      // 悬停操作：删除
      const actions = document.createElement('div');
      actions.className = 'msg-actions';

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'msg-action-btn delete-btn';
      deleteBtn.title = '删除此消息';
      deleteBtn.innerHTML = DELETE_ICON;
      deleteBtn.addEventListener('click', () => deleteUserMessage(row));
      actions.appendChild(deleteBtn);

      row.appendChild(actions);
      messagesEl.appendChild(row);
      scrollToBottom();
    }

    /** 删除用户消息及其后续助手回合 */
    function deleteUserMessage(row) {
      if (isStreaming) return;
      const next = row.nextElementSibling;
      if (next && next.classList.contains('turn')) {
        next.remove();
      }
      row.remove();
    }

    /** 复制图标 SVG */
    const COPY_ICON = \`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="8" height="10" rx="1.5"/><path d="M3 5v7a1.5 1.5 0 0 0 1.5 1.5H11"/></svg>\`;
    const COPIED_ICON = \`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6"/></svg>\`;
    const LIKE_ICON = \`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5L5.5 6.5v7h6l1.5-4V8h-4l.5-2.5L7 3.5z"/><path d="M5.5 6.5H3.5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h2"/></svg>\`;
    const LIKED_ICON = \`<svg viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5L5.5 6.5v7h6l1.5-4V8h-4l.5-2.5L7 3.5z"/><path d="M5.5 6.5H3.5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h2"/></svg>\`;
    const DELETE_ICON = \`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M5.5 4V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4M4.5 4v9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4"/><path d="M6.5 7.5v3.5M9.5 7.5v3.5"/></svg>\`;

    /** 执行复制操作 */
    async function copyText(text, btn) {
      try {
        await navigator.clipboard.writeText(text || '');
      } catch (err) {
        const textarea = document.createElement('textarea');
        textarea.value = text || '';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      btn.classList.add('copied');
      btn.innerHTML = COPIED_ICON;
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = COPY_ICON;
      }, 2000);
    }

    /** 格式化数字（千分位） */
    function formatNumber(n) {
      if (typeof n !== 'number' || n === 0) return '0';
      return n.toLocaleString('en-US');
    }

    /** 按云端上下文上限格式化本轮 Token 用量 */
    function formatTokenUsage(usage, inputLength) {
      const total = usage && Number.isFinite(usage.total_tokens) ? usage.total_tokens : 0;
      const prompt = usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
      const completion = usage && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
      if (total <= 0 || !Number.isFinite(inputLength) || inputLength <= 0) {
        return { text: '--', title: 'Token 用量不可用', percent: null };
      }
      const percent = Number(((total / inputLength) * 100).toFixed(1));
      const ratio = formatNumber(total) + ' / ' + formatNumber(inputLength) + ' (' + percent.toFixed(1) + '%)';
      return {
        text: ratio,
        title: '本轮 Token 消耗：' + ratio + '；输入 ' + formatNumber(prompt) + '，输出 ' + formatNumber(completion),
        percent,
      };
    }

    /** 创建消息操作栏 */
    function createMsgActions(getText, onDelete) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';

      // Token 用量显示
      const tokenUsage = document.createElement('span');
      tokenUsage.className = 'token-usage';
      tokenUsage.innerHTML = \`
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="8" r="6"/>
          <path d="M8 4v4l2 2"/>
        </svg>
        <span class="token-count">--</span>
        <span class="token-progress" hidden><span class="token-progress-fill"></span></span>
      \`;
      tokenUsage.title = 'Token 用量不可用';
      actions.appendChild(tokenUsage);

      // 复制按钮
      const copyBtn = document.createElement('button');
      copyBtn.className = 'msg-action-btn copy-btn';
      copyBtn.title = '复制回复';
      copyBtn.innerHTML = COPY_ICON;
      copyBtn.addEventListener('click', () => copyText(getText(), copyBtn));
      actions.appendChild(copyBtn);

      // 点赞按钮
      const likeBtn = document.createElement('button');
      likeBtn.className = 'msg-action-btn like-btn';
      likeBtn.title = '点赞';
      likeBtn.innerHTML = LIKE_ICON;
      likeBtn.addEventListener('click', () => {
        likeBtn.classList.toggle('liked');
        likeBtn.innerHTML = likeBtn.classList.contains('liked') ? LIKED_ICON : LIKE_ICON;
      });
      actions.appendChild(likeBtn);

      // 删除按钮
      if (onDelete) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'msg-action-btn delete-btn';
        deleteBtn.title = '删除此消息';
        deleteBtn.innerHTML = DELETE_ICON;
        deleteBtn.addEventListener('click', onDelete);
        actions.appendChild(deleteBtn);
      }

      return actions;
    }

    /** 更新消息的 token 显示 */
    function updateMsgTokenUsage(row, usage, inputLength) {
      if (!row) return;
      const tokenEl = row.querySelector('.token-usage');
      if (!tokenEl || !usage) return;

      const formatted = formatTokenUsage(usage, inputLength);

      const countEl = tokenEl.querySelector('.token-count');
      if (countEl) {
        countEl.textContent = formatted.text;
      }
      tokenEl.title = formatted.title;

      const progressEl = tokenEl.querySelector('.token-progress');
      const progressFillEl = tokenEl.querySelector('.token-progress-fill');
      if (progressEl && progressFillEl) {
        progressEl.hidden = formatted.percent === null;
        progressFillEl.style.width = formatted.percent === null
          ? '0'
          : Math.min(formatted.percent, 100) + '%';
      }
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

      // 添加操作栏，使用getter函数动态获取最新文本
      const actions = createMsgActions(() => currentAssistantTxt || bubble.textContent || '', () => {
        if (isStreaming) return;
        const turnEl = row.closest('.turn');
        if (turnEl) turnEl.remove();
      });
      row.appendChild(actions);

      turn.rootEl.appendChild(row);
      currentAssistantRow = row;
      smartScrollToBottom();
      return bubble;
    }

    /** 流式文本轻量追加（纯文本，避免逐 chunk 全量 markdown 重渲染）。 */
    function updateAssistantMsg(chunk) {
      currentAssistantTxt += chunk;
      if (!currentAssistantEl) {
        currentAssistantEl = appendAssistantBubble(true);
      }
      currentAssistantEl.textContent = currentAssistantTxt;
      smartScrollToBottom();
    }

    /** 步末终渲染：把当前步已完整的纯文本渲染为 markdown，收尾光标，准备下一条消息。 */
    function finalizeStepText() {
      if (currentAssistantEl) {
        if (currentAssistantTxt) {
          renderMarkdown(currentAssistantEl, currentAssistantTxt);
        }
        currentAssistantEl.classList.remove('cursor');
      }
      currentAssistantEl = null;
      currentAssistantTxt = '';
    }

    function appendMsgFromHistory(role, text, tokenUsage) {
      if (role === 'user') { appendUserMsg(text); return; }
      const turn = ensureTurn();
      const row = document.createElement('div');
      row.className = 'msg-row';
      row.innerHTML = '<div class="msg-label">回复</div>';
      const bubble = document.createElement('div');
      bubble.className = 'message assistant';
      row.appendChild(bubble);
      renderMarkdown(bubble, text);

      // 添加操作栏（历史消息使用闭包捕获text）
      const actions = createMsgActions(() => text, () => {
        if (isStreaming) return;
        const turnEl = row.closest('.turn');
        if (turnEl) turnEl.remove();
      });
      row.appendChild(actions);
      if (tokenUsage) {
        updateMsgTokenUsage(row, tokenUsage);
      }

      turn.rootEl.appendChild(row);
      finishTurn();
      scrollToBottom();
    }

    function mergeStreamText(current, incoming) {
      if (!incoming) return current;
      if (!current || incoming.startsWith(current)) return incoming;
      if (current.startsWith(incoming) || current.endsWith(incoming)) return current;
      return current + incoming;
    }

    let compactionEl = null;
    function showCompaction(active) {
      if (active && !compactionEl) {
        compactionEl = document.createElement('div');
        compactionEl.className = 'step compaction';
        compactionEl.innerHTML = '<span class="step-dot"></span><span class="step-name">正在压缩上下文…</span>';
        addStep(compactionEl);
        smartScrollToBottom();
      } else if (!active && compactionEl) {
        const nameEl = compactionEl.querySelector('.step-name');
        if (nameEl) nameEl.textContent = '上下文压缩完成';
        compactionEl = null;
      }
    }

    function showThought(text) {
      currentThoughtTxt = mergeStreamText(currentThoughtTxt, text);
      if (!currentThoughtEl) {
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
        step.appendChild(body);
        addStep(step);
        currentThoughtEl = step;
      }

      const body = currentThoughtEl.querySelector('.step-body');
      body.textContent = currentThoughtTxt;
      smartScrollToBottom();
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

    /** 显示 token 用量信息 */
    function showTokenUsage(payload) {
      if (!payload) return;
      // 优先使用当前回复，引用丢失时回退到最后一条 assistant 消息
      let row = currentAssistantRow;
      if (!row && messagesEl) {
        const assistantMessages = messagesEl.querySelectorAll('.message.assistant');
        const lastAssistant = assistantMessages.length > 0
          ? assistantMessages[assistantMessages.length - 1]
          : null;
        row = lastAssistant ? lastAssistant.parentElement : null;
      }
      if (row) {
        updateMsgTokenUsage(row, payload.token_usage, payload.input_length);
        // 更新后清空引用，避免影响后续消息
        currentAssistantRow = null;
      }
    }

    function showError(msg) {
      errorEl.textContent = msg;
      setTimeout(() => { if (errorEl.textContent === msg) errorEl.textContent = ''; }, 5000);
    }

    function updateInteractionState() {
      sendBtn.disabled = isStreaming || !currentSessionId;
      inputEl.disabled = isStreaming || !currentSessionId;
      openFileBtn.disabled = isStreaming;
    }

    function setStreaming(state) {
      isStreaming = state;
      sendBtn.style.display = state ? 'none' : 'inline-flex';
      stopBtn.style.display = state ? 'inline-flex' : 'none';
      stopBtn.disabled = !state;
      updateInteractionState();
    }


    // ── Host message handler ──
    window.addEventListener('message', (e) => {
      const msg = e.data;
      switch (msg.command) {
        case 'sessionCreated': {
          currentSessionId = msg.sessionId;
          resetConversation();
          setStreaming(false);
          vscode.postMessage({ command: 'loadHistory', sessionId: currentSessionId });
          break;
        }
        case 'replyChunk':
          updateAssistantMsg(msg.text);
          break;
        case 'replyEnd':
          setStreaming(false);
          finalizeStepText();
          // currentAssistantRow 由 token_usage 事件更新后清理
          finishTurn();
          break;
        case 'stepEnd':
          finalizeStepText();
          break;
        case 'toolState':
          showToolState(msg.tool, msg.state, msg.error, msg.call_id, msg.args, msg.output);
          break;
        case 'toolCall':
          showToolState(msg.tool, 'pending', undefined, msg.call_id, msg.args);
          break;
        case 'toolResult':
          // tool_result 仅作补充数据，不单独渲染（tool_state_change 已覆盖）
          break;
        case 'thought':
          showThought(msg.text);
          break;
        case 'progress':
          showCompaction(msg.phase === 'compacting');
          break;
        case 'plan':
          showPlan(msg.steps);
          break;
        case 'tokenUsage':
          showTokenUsage(msg.payload);
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
          for (const m of msg.messages) {
            if (m.role === 'tool' && m.toolCallId) {
              // 工具结果消息：更新已有 pending 工具步骤，或创建已完成步骤
              let entry = toolEntries.get(m.toolCallId);
              if (entry) {
                entry.state = 'success';
                entry.output = m.content;
                entry.stepEl.className = 'step tool clickable success' + (entry.stepEl.classList.contains('expanded') ? ' expanded' : '');
                entry.stepEl.querySelector('.step-status').innerHTML = getStatusIcon('success');
                if (m.content) {
                  entry.detailEl.innerHTML += '<div class="detail-label">结果</div><div class="detail-block">' + escapeHtml(truncate(m.content, 2000)) + '</div>';
                }
              } else {
                showToolState('tool', 'success', undefined, m.toolCallId, undefined, m.content);
              }
            } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
              // 含工具调用的 assistant 消息：先渲染工具 pending 步骤，再渲染回复文本
              for (const tc of m.toolCalls) {
                let parsedArgs;
                try { parsedArgs = JSON.parse(tc.arguments); } catch { parsedArgs = {}; }
                showToolState(tc.name, 'success', undefined, tc.id, parsedArgs);
              }
              if (m.content) {
                appendMsgFromHistory('assistant', m.content);
              }
            } else {
              appendMsgFromHistory(m.role, m.content);
            }
          }
          scrollToBottom();
          break;
        case 'error':
          showError(msg.message);
          if (isStreaming) {
            setStreaming(false);
            finalizeStepText();
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
        case 'modelInfo':
          document.getElementById('modelName').textContent = msg.model || '--';
          break;
      }
    });

    // init - auto-create first session
    vscode.postMessage({ command: 'createSession' });
`;
  }
}
