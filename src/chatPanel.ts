import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { ToolRegistry } from './core/toolRegistry';
import type { EventBus, AgentEvent } from './core/eventBus';
import type { LocalSessionManager } from './core/localSessionManager';
import type { SkillRegistry } from './skill/skillRegistry';
import { buildSlashCommandGroups } from './chat/slashCommands';
import { DEFAULT_MAX_FILE_SIZE, isBinaryExt, redactSecrets } from './tools/fs/readFile';
import * as logger from './logger';

interface ChatViewDeps {
  readonly sessionManager: LocalSessionManager;
  readonly registry: ToolRegistry;
  readonly eventBus: EventBus;
}

/** 待处理的审批请求：call_id -> resolve 回调 */
type ApprovalResolver = (decision: 'allow' | 'always' | 'deny') => void;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _panel?: vscode.WebviewPanel; // 编辑区对话面板（单例，用户关闭后置空）
  private _settingsPanel?: vscode.WebviewPanel; // 编辑区设置面板（单例，用户关闭后置空）
  private readonly _registry: ToolRegistry;
  private readonly _sessionManager: LocalSessionManager;
  private readonly _eventBus: EventBus;
  private _currentSessionId?: string;
  private _createSessionRequest = 0;
  private readonly _pendingApprovals = new Map<string, ApprovalResolver>();
  private _skillRegistry?: SkillRegistry;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    deps: ChatViewDeps
  ) {
    this._registry = deps.registry;
    this._sessionManager = deps.sessionManager;
    this._eventBus = deps.eventBus;
  }

  /**
   * 注入 Skill 注册表（装配完成后调用，用于组装斜杠命令数据）。
   *
   * @param skillRegistry Skill 注册表
   */
  setSkillRegistry(skillRegistry: SkillRegistry): void {
    this._skillRegistry = skillRegistry;
  }

  /**
   * 向 webview 推送最新的斜杠命令分组数据（webview 未就绪时忽略）。
   */
  private _pushSlashCommands(panel: vscode.WebviewPanel): void {
    panel.webview.postMessage({
      command: 'slashCommands',
      groups: buildSlashCommandGroups(this._skillRegistry),
    });
  }

  /**
   * 刷新斜杠命令数据：skill 注册/配置变更后由扩展侧调用，重新推送分组。
   */
  refreshSlashCommands(): void {
    if (this._panel) {
      this._pushSlashCommands(this._panel);
    }
  }

  /**
   * 打开对话面板：在编辑器区域创建（或聚焦）单例 WebviewPanel。
   * 命令面板与侧边栏图标入口均会调用；面板已存在时仅聚焦不重建。
   */
  show(): void {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    this._panel = this._createPanel();
  }

  /**
   * 侧边栏 WebviewView 入口（点击 activity bar 图标触发）：
   * 在编辑区打开对话面板，侧边栏渲染引导提示页。
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    webviewView.webview.html = this._getSidebarGuideHtml();
    this.show();
  }

  /**
   * 创建编辑区对话面板并完成 webview 初始化（消息监听、事件总线订阅、初始数据推送）。
   * @returns 新创建的 WebviewPanel
   */
  private _createPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      'yunxiaoAgent.chatPanel',
      '云效 Agent',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this._context.extensionPath, 'dist')),
          vscode.Uri.file(path.join(this._context.extensionPath, 'media')),
        ],
      }
    );
    panel.iconPath = vscode.Uri.file(path.join(this._context.extensionPath, 'media', 'icon.png'));

    panel.webview.html = this._getHtml(panel.webview, 'chat');

    panel.webview.onDidReceiveMessage(
      async (msg: { command: string;[key: string]: unknown }) => {
        await this._handleMessage(msg);
      },
      undefined,
      this._context.subscriptions
    );

    // 订阅事件总线，将当前会话的事件转发给 webview；面板关闭时取消订阅，避免重复转发
    const unsub = this._eventBus.onAll((e) => this._forwardEvent(e));
    this._context.subscriptions.push({ dispose: unsub });

    // 面板关闭时清空引用、取消事件订阅，并将未决审批回退为 deny（避免 AgentLoop 挂起）
    panel.onDidDispose(
      () => {
        logger.log('[ChatPanel] 编辑区对话面板已关闭');
        if (this._panel === panel) {
          this._panel = undefined;
        }
        unsub();
        for (const resolve of this._pendingApprovals.values()) {
          resolve('deny');
        }
        this._pendingApprovals.clear();
      },
      undefined,
      this._context.subscriptions
    );

    // 发送当前模型名称到 webview
    const modelConfig = vscode.workspace.getConfiguration('yunxiaoAgent.model');
    const modelName = modelConfig.get<string>('model', '');
    if (modelName) {
      panel.webview.postMessage({ command: 'modelInfo', model: modelName });
    }

    // 推送斜杠命令分组（webview 侧亦可主动 requestSlashCommands 拉取）
    this._pushSlashCommands(panel);

    logger.log('[ChatPanel] 编辑区对话面板已打开');
    return panel;
  }

  /**
   * 打开设置面板：在编辑器区域创建（或聚焦）独立的单例 WebviewPanel。
   */
  private _showSettingsPanel(): void {
    if (this._settingsPanel) {
      this._settingsPanel.reveal(vscode.ViewColumn.Active);
      return;
    }
    this._settingsPanel = this._createSettingsPanel();
  }

  /**
   * 创建独立设置面板并加载设置入口的 Webview 应用。
   * @returns 新创建的设置 WebviewPanel
   */
  private _createSettingsPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      'yunxiaoAgent.settingsPanel',
      '云效 Agent 设置',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this._context.extensionPath, 'dist')),
          vscode.Uri.file(path.join(this._context.extensionPath, 'media')),
        ],
      }
    );
    panel.iconPath = vscode.Uri.file(path.join(this._context.extensionPath, 'media', 'icon.png'));
    panel.webview.html = this._getHtml(panel.webview, 'settings');
    panel.onDidDispose(
      () => {
        logger.log('[ChatPanel] 编辑区设置面板已关闭');
        if (this._settingsPanel === panel) {
          this._settingsPanel = undefined;
        }
      },
      undefined,
      this._context.subscriptions
    );
    logger.log('[ChatPanel] 编辑区设置面板已打开');
    return panel;
  }

  /**
   * 侧边栏入口的引导提示页（对话界面实际在编辑区，此处仅提示）。
   * @returns 引导页 HTML
   */
  private _getSidebarGuideHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
</head>
<body style="margin:0;padding:16px;font-family:var(--vscode-font-family);color:var(--vscode-foreground);">
  <p>云效 Agent 对话面板已在编辑区打开。</p>
  <p><a href="command:yunxiaoAgent.openPanel">在编辑区打开对话面板</a></p>
</body>
</html>`;
  }

  /** 将当前会话的事件总线事件转发给 webview。 */
  private _forwardEvent(e: AgentEvent): void {
    const panel = this._panel;
    if (!panel || e.sessionId !== this._currentSessionId) {
      return;
    }
    switch (e.type) {
      case 'content':
        panel.webview.postMessage({ command: 'replyChunk', text: e.payload as string });
        break;
      case 'step_end':
        panel.webview.postMessage({ command: 'stepEnd' });
        break;
      case 'token_usage':
        panel.webview.postMessage({ command: 'tokenUsage', payload: e.payload });
        break;
      case 'session_token_usage':
        panel.webview.postMessage({ command: 'sessionTokenUsage', payload: e.payload });
        break;
      case 'stream_end':
        panel.webview.postMessage({ command: 'replyEnd' });
        break;
      case 'error':
        panel.webview.postMessage({ command: 'error', message: e.payload as string });
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
        panel.webview.postMessage({ command: 'toolState', ...p });
        // code_edit 成功且有 diff 数据时，额外发送 diffResult 命令
        if (p.tool === 'code_edit' && p.state === 'success' && p.output) {
          const out = p.output as Record<string, unknown>;
          if (out.diff) {
            panel.webview.postMessage({
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
        panel.webview.postMessage({ command: 'toolCall', ...p });
        break;
      }
      case 'tool_result': {
        const p = e.payload as { call_id: string; status: string; result?: unknown; error?: string };
        panel.webview.postMessage({ command: 'toolResult', ...p });
        break;
      }
      case 'thought':
        panel.webview.postMessage({ command: 'thought', text: e.payload as string });
        break;
      case 'progress': {
        const p = e.payload as { phase?: string };
        panel.webview.postMessage({ command: 'progress', phase: p.phase });
        break;
      }
      case 'plan': {
        const p = e.payload as { steps: string[] };
        panel.webview.postMessage({ command: 'plan', steps: p.steps });
        break;
      }
      default:
        break;
    }
  }

  /** 从工具栏"新建会话"按钮触发 */
  triggerNewSession(): void {
    this._panel?.webview.postMessage({ command: 'triggerNewSession' });
  }

  /**
   * 从历史下拉打开会话（回放/继续对话共用）：切换当前会话并通知前端加载历史。
   * @param sessionId 会话 ID
   * @param title 会话标题（为空时前端保持当前输入框文案）
   */
  openSession(sessionId: string, title?: string): void {
    this._sessionManager.setCurrentSessionId(sessionId);
    this._currentSessionId = sessionId;
    this._panel?.webview.postMessage({ command: 'openSession', sessionId, title });
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
    const panel = this._panel;
    return new Promise<'allow' | 'always' | 'deny'>((resolve) => {
      if (!panel || sessionId !== this._currentSessionId) {
        // 视图不可见或会话不匹配，回退为 deny（安全保守）
        resolve('deny');
        return;
      }
      this._pendingApprovals.set(callId, resolve);
      panel.webview.postMessage({
        command: 'approvalRequest',
        call_id: callId,
        tool_name: toolName,
        summary,
        file_path: filePath,
      });
    });
  }

  private async _handleMessage(msg: { command: string;[key: string]: unknown }): Promise<void> {
    const panel = this._panel;
    if (!panel) { return; }

    logger.log(`[ChatPanel] 收到 webview 消息: ${msg.command}`);

    switch (msg.command) {
      case 'webviewReady': {
        // 握手：UI 挂载完成后推送模型名与斜杠命令初始数据（应对 webview 重建后的数据丢失）
        const modelConfig = vscode.workspace.getConfiguration('yunxiaoAgent.model');
        const modelName = modelConfig.get<string>('model', '');
        if (modelName) {
          panel.webview.postMessage({ command: 'modelInfo', model: modelName });
        }
        this._pushSlashCommands(panel);
        break;
      }
      case 'openSettings': {
        this._showSettingsPanel();
        break;
      }
      case 'createSession': {
        const requestId = ++this._createSessionRequest;
        // 新建会话保留旧会话数据（历史永存），仅切换当前指针
        const sessionId = this._sessionManager.createSession();
        if (requestId !== this._createSessionRequest) {
          break;
        }
        this._currentSessionId = sessionId;
        panel.webview.postMessage({ command: 'sessionCreated', sessionId });
        break;
      }
      case 'sendMessage': {
        const sessionId = msg.sessionId as string;
        const userText = (msg.text as string) ?? '';
        const files = Array.isArray(msg.files)
          ? (msg.files as { path: string }[])
          : [];
        const skills = Array.isArray(msg.skills)
          ? (msg.skills as string[])
          : [];
        let text = userText;
        // 已选 Skill 引用块转成斜杠命令文本（如 /plan），前置到用户消息
        if (skills.length > 0) {
          const skillBlock = skills.map((name) => `/${name}`).join('\n');
          text = userText ? `${skillBlock}\n\n${userText}` : skillBlock;
        }
        // 读取引用文件内容，拼接为结构化上下文前置到用户文本（见 _buildFileContext）
        if (files.length > 0) {
          const contextBlock = await this._buildFileContext(files);
          text = text ? `${contextBlock}\n\n${text}` : contextBlock;
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
        panel.webview.postMessage({ command: 'historyLoaded', messages: history });
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
      case 'requestSlashCommands': {
        // webview 主动拉取斜杠命令分组（应对 webview 重建后的数据丢失）
        this._pushSlashCommands(panel);
        break;
      }
      case 'requestWorkspaceFiles': {        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        if (workspaceFolders.length === 0) {
          panel.webview.postMessage({ command: 'workspaceFiles', files: [] });
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
        panel.webview.postMessage({ command: 'workspaceFiles', files });
        break;
      }
      case 'renameSession': {
        const sessionId = msg.sessionId as string;
        const name = msg.name as string;
        if (sessionId && name) {
          // 持久化到会话索引（customTitle=true，优先于默认标题）
          this._sessionManager.renameSession(sessionId, name);
        }
        break;
      }
      case 'requestSessions': {
        // 前端打开历史下拉时请求最新会话列表
        const sessions = this._sessionManager.listSessions();
        logger.log(`[ChatPanel] 返回会话列表 count=${sessions.length}`);
        panel.webview.postMessage({ command: 'sessionList', sessions });
        break;
      }
      case 'openSession': {
        // 前端历史下拉点击：切换当前会话指针并回推 openSession 供前端加载历史（附标题供输入框展示）
        const sessionId = msg.sessionId as string;
        if (sessionId) {
          const meta = this._sessionManager.listSessions().find((s) => s.sessionId === sessionId);
          this.openSession(sessionId, meta?.title || '');
        }
        break;
      }
      case 'deleteSession': {
        const sessionId = msg.sessionId as string;
        if (!sessionId) {
          break;
        }
        const meta = this._sessionManager.listSessions().find((s) => s.sessionId === sessionId);
        const title = meta?.title || '新会话';
        const confirm = await vscode.window.showWarningMessage(
          `确定删除会话「${title}」？该操作不可恢复。`,
          { modal: true },
          '删除'
        );
        if (confirm === '删除') {
          this._sessionManager.deleteSession(sessionId);
          if (this._currentSessionId === sessionId) {
            this._currentSessionId = undefined;
            // 显式通知前端当前会话已被删除（空会话可能不在会话列表中，
            // 前端不能再靠「列表缺当前会话」推断删除，否则会误禁用输入框）
            panel.webview.postMessage({ command: 'currentSessionDeleted' });
          }
        }
        // 无论是否删除都回推最新列表，前端据此判断当前会话是否已被删除
        panel.webview.postMessage({ command: 'sessionList', sessions: this._sessionManager.listSessions() });
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

  /**
   * 生成最小 Webview HTML shell：仅包含根挂载节点、外部样式链接与外部模块脚本。
   * 资源 URL 由 `webview.asWebviewUri()` 生成并受 `localResourceRoots` 约束；
   * 界面样式、DOM 与交互全部由 `dist/webview-ui/` 的 React bundle 承担。
   *
   * @param webview 目标 Webview（用于生成可加载的资源 URI）
   * @returns Webview HTML 字符串
   */
  private _getHtml(webview: vscode.Webview, page: 'chat' | 'settings' = 'chat'): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this._context.extensionPath, 'dist', 'webview-ui', 'index.js'))
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this._context.extensionPath, 'dist', 'webview-ui', 'index.css'))
    );

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <title>${page === 'settings' ? '云效 Agent 设置' : '云效 Agent'}</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body data-view="${page}">
  <div id="root"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
