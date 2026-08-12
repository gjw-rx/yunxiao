import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { ToolRegistry } from './core/toolRegistry';
import type { EventBus, AgentEvent } from './core/eventBus';
import type { LocalSessionManager } from './core/localSessionManager';
import type { SkillRegistry } from './skill/skillRegistry';
import type { ModelConfigStore, ModelSettingsInput } from './config/modelConfigStore';
import type { ModelConfig } from './config/modelConfig';
import type { SyncSource } from './config/syncConfig';
import type { SkillInstallResult } from './skill/skillInstaller';
import type { RuntimeStatus } from './webview-ui/protocol';
import { buildSlashCommandGroups } from './chat/slashCommands';
import { DEFAULT_MAX_FILE_SIZE, isBinaryExt, redactSecrets } from './tools/fs/readFile';
import * as logger from './logger';

interface ChatViewDeps {
  readonly sessionManager: LocalSessionManager;
  readonly registry: ToolRegistry;
  readonly eventBus: EventBus;
}

/** 设置面板依赖：模型存储、配置来源、Skill 安装与模型保存回调。 */
interface SettingsPanelDeps {
  /** 插件私有模型配置存储 */
  readonly modelStore: ModelConfigStore;
  /** 读取配置来源（none/claude/trae） */
  readonly getSyncSource: () => SyncSource;
  /** 读取用户配置的 Skill 加载目录 */
  readonly getSkillDirectories: () => string[];
  /** 保存配置来源（保存后由扩展侧完成 Skill 重新同步后再返回） */
  readonly setSyncSource: (source: SyncSource) => Promise<SyncSource>;
  /** 保存 Skill 加载目录并完成重新加载 */
  readonly setSkillDirectories: (directories: readonly string[]) => Promise<string[]>;
  /** 当前生效的模型名称（对话/设置面板头部展示） */
  readonly getModelName: () => string;
  /** 选择并安装项目 Skill ZIP（完成后由扩展侧刷新注册表与斜杠菜单） */
  readonly uploadSkillArchive: () => Promise<SkillInstallResult>;
  /** 模型配置保存成功回调（扩展侧重建 provider 并更新 AgentLoop） */
  readonly onModelConfigSaved?: (config: ModelConfig) => void;
}

/** 待处理的审批请求：call_id -> resolve 回调 */
type ApprovalResolver = (decision: 'allow' | 'always' | 'deny') => void;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _chatView?: vscode.WebviewView; // 侧栏对话视图（用户隐藏后置空）
  private _chatWebview?: vscode.Webview; // 当前侧栏对话 Webview
  private _chatMessageDisposable?: vscode.Disposable; // 当前聊天 Webview 消息监听器
  private _unsubscribeChatEvents?: () => void; // 当前聊天事件总线取消订阅函数
  private _settingsPanel?: vscode.WebviewPanel; // 编辑区设置面板（单例，用户关闭后置空）
  private readonly _registry: ToolRegistry;
  private readonly _sessionManager: LocalSessionManager;
  private readonly _eventBus: EventBus;
  private _currentSessionId?: string;
  private _createSessionRequest = 0;
  private readonly _pendingApprovals = new Map<string, ApprovalResolver>();
  private _skillRegistry?: SkillRegistry;
  private _settingsDeps?: SettingsPanelDeps;
  /** 当前扩展运行时状态；未就绪时拒绝聊天业务消息。 */
  private _runtimeStatus: RuntimeStatus = 'initializing';
  /** 运行时失败时可显示的简要错误信息。 */
  private _runtimeMessage?: string;

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
   * 注入设置面板依赖（模型存储、配置来源、Skill 安装与模型保存回调）。
   *
   * @param deps 设置面板依赖
   */
  setSettingsDeps(deps: SettingsPanelDeps): void {
    this._settingsDeps = deps;
  }

  /**
   * 更新扩展运行时状态并通知已打开的聊天 Webview。
   *
   * @param status 新的运行时状态
   * @param message 初始化失败时展示的简要错误信息
   * @returns void
   */
  setRuntimeStatus(status: RuntimeStatus, message?: string): void {
    this._runtimeStatus = status;
    this._runtimeMessage = message;
    if (this._chatWebview) {
      this._pushRuntimeState(this._chatWebview);
    }
    logger.log(`[ChatPanel] 运行时状态已更新 status=${status}${message ? ` message=${message}` : ''}`);
  }

  /**
   * 向指定聊天 Webview 发送当前运行时状态。
   *
   * @param webview 接收状态的聊天 Webview
   * @returns void
   */
  private _pushRuntimeState(webview: vscode.Webview): void {
    webview.postMessage({
      command: 'runtimeState',
      status: this._runtimeStatus,
      ...(this._runtimeMessage ? { message: this._runtimeMessage } : {}),
    });
  }

  /**
   * 向 webview 推送最新的斜杠命令分组数据（webview 未就绪时忽略）。
   *
   * @param webview 接收斜杠命令分组的聊天 Webview
   * @returns void
   */
  private _pushSlashCommands(webview: vscode.Webview): void {
    webview.postMessage({
      command: 'slashCommands',
      groups: buildSlashCommandGroups(this._skillRegistry),
    });
  }

  /**
   * 刷新斜杠命令数据：skill 注册/配置变更后由扩展侧调用，重新推送分组。
   *
   * @returns void
   */
  refreshSlashCommands(): void {
    if (this._chatWebview && this._runtimeStatus === 'ready') {
      this._pushSlashCommands(this._chatWebview);
    }
  }

  /**
   * 打开侧栏对话视图：聚焦扩展的 View Container，不创建编辑器标签。
   *
   * @returns void
   */
  show(): void {
    logger.log('[ChatPanel] 请求打开侧栏对话视图');
    void vscode.commands.executeCommand('workbench.view.extension.yunxiaoAgentContainer').then(
      () => {
        this._chatView?.show();
        logger.log('[ChatPanel] 侧栏对话视图已聚焦');
      },
      (err) => logger.error(`[ChatPanel] 打开侧栏对话视图失败: ${err instanceof Error ? err.message : String(err)}`)
    );
  }

  /**
   * 解析侧栏 WebviewView 并完成聊天 Webview 初始化。
   *
   * @param webviewView VS Code 提供的侧栏视图
   * @param _ctx 视图恢复上下文
   * @param _token 解析取消令牌
   * @returns void
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._chatMessageDisposable?.dispose();
    this._unsubscribeChatEvents?.();
    const webview = webviewView.webview;
    this._chatView = webviewView;
    this._chatWebview = webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this._context.extensionPath, 'dist')),
        vscode.Uri.file(path.join(this._context.extensionPath, 'media')),
      ],
    };
    webview.html = this._getHtml(webview, 'chat');

    const messageDisposable = webview.onDidReceiveMessage(
      async (msg: { command: string;[key: string]: unknown }) => {
        await this._handleMessage(msg);
      }
    );
    this._chatMessageDisposable = messageDisposable;

    // 订阅事件总线，将当前会话的事件转发给 webview；视图销毁时取消订阅，避免重复转发
    const unsub = this._eventBus.onAll((e) => this._forwardEvent(e));
    this._unsubscribeChatEvents = unsub;

    // 视图销毁时清空引用、取消事件订阅，并将未决审批回退为 deny（避免 AgentLoop 挂起）
    webviewView.onDidDispose(
      () => {
        messageDisposable.dispose();
        unsub();
        if (this._chatView !== webviewView) {
          return;
        }
        logger.log('[ChatPanel] 侧栏对话视图已销毁');
        this._chatView = undefined;
        this._chatWebview = undefined;
        this._chatMessageDisposable = undefined;
        this._unsubscribeChatEvents = undefined;
        for (const resolve of this._pendingApprovals.values()) {
          resolve('deny');
        }
        this._pendingApprovals.clear();
      }
    );

    logger.log(`[ChatPanel] 侧栏对话视图已解析 runtimeStatus=${this._runtimeStatus}`);
  }

  /**
   * 将当前生效模型名称推送到已打开的对话面板。
   *
   * @returns void
   */
  refreshModelInfo(): void {
    const modelName = this._settingsDeps?.getModelName() ?? '';
    if (!this._chatWebview || !modelName) {
      return;
    }
    this._chatWebview.postMessage({ command: 'modelInfo', model: modelName });
    logger.log(`[ChatPanel] 已刷新对话模型信息 model=${modelName}`);
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

    // 设置面板消息路由：模型配置读取/保存、Skill 列表读取、来源切换与安装请求
    panel.webview.onDidReceiveMessage(
      async (msg: { command: string; [key: string]: unknown }) => {
        await this._handleSettingsMessage(panel, msg);
      },
      undefined,
      this._context.subscriptions
    );

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
   * 将当前会话的事件总线事件转发给聊天 Webview。
   *
   * @param e 待转发的 Agent 事件
   * @returns void
   */
  private _forwardEvent(e: AgentEvent): void {
    const webview = this._chatWebview;
    if (!webview || e.sessionId !== this._currentSessionId) {
      return;
    }
    switch (e.type) {
      case 'content':
        webview.postMessage({ command: 'replyChunk', text: e.payload as string });
        break;
      case 'step_end':
        webview.postMessage({ command: 'stepEnd' });
        break;
      case 'token_usage':
        webview.postMessage({ command: 'tokenUsage', payload: e.payload });
        break;
      case 'session_token_usage':
        webview.postMessage({ command: 'sessionTokenUsage', payload: e.payload });
        break;
      case 'stream_end':
        webview.postMessage({ command: 'replyEnd' });
        break;
      case 'error':
        webview.postMessage({ command: 'error', message: e.payload as string });
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
        webview.postMessage({ command: 'toolState', ...p });
        // code_edit 成功且有 diff 数据时，额外发送 diffResult 命令
        if (p.tool === 'code_edit' && p.state === 'success' && p.output) {
          const out = p.output as Record<string, unknown>;
          if (out.diff) {
            webview.postMessage({
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
        webview.postMessage({ command: 'toolCall', ...p });
        break;
      }
      case 'tool_result': {
        const p = e.payload as { call_id: string; status: string; result?: unknown; error?: string };
        webview.postMessage({ command: 'toolResult', ...p });
        break;
      }
      case 'thought':
        webview.postMessage({ command: 'thought', text: e.payload as string });
        break;
      case 'progress': {
        const p = e.payload as { phase?: string };
        webview.postMessage({ command: 'progress', phase: p.phase });
        break;
      }
      case 'plan': {
        const p = e.payload as { steps: string[] };
        webview.postMessage({ command: 'plan', steps: p.steps });
        break;
      }
      default:
        break;
    }
  }

  /**
   * 从工具栏“新建会话”按钮触发前端创建会话。
   *
   * @returns void
   */
  triggerNewSession(): void {
    if (this._runtimeStatus !== 'ready') {
      logger.log(`[ChatPanel] 运行时未就绪，忽略新建会话请求 status=${this._runtimeStatus}`);
      return;
    }
    this._chatWebview?.postMessage({ command: 'triggerNewSession' });
  }

  /**
   * 从历史下拉打开会话（回放/继续对话共用）：切换当前会话并通知前端加载历史。
   * @param sessionId 会话 ID
   * @param title 会话标题（为空时前端保持当前输入框文案）
   * @returns void
   */
  openSession(sessionId: string, title?: string): void {
    this._sessionManager.setCurrentSessionId(sessionId);
    this._currentSessionId = sessionId;
    this._chatWebview?.postMessage({ command: 'openSession', sessionId, title });
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
   * @returns 用户审批结果
   */
  requestApproval(
    callId: string,
    toolName: string,
    summary: string,
    filePath: string | undefined,
    sessionId: string
  ): Promise<'allow' | 'always' | 'deny'> {
    const webview = this._chatWebview;
    return new Promise<'allow' | 'always' | 'deny'>((resolve) => {
      if (!webview || !this._chatView?.visible || sessionId !== this._currentSessionId) {
        // 视图不可见或会话不匹配，回退为 deny（安全保守）
        logger.log(`[ChatPanel] 审批视图不可用，自动拒绝 callId=${callId} sessionId=${sessionId}`);
        resolve('deny');
        return;
      }
      this._pendingApprovals.set(callId, resolve);
      webview.postMessage({
        command: 'approvalRequest',
        call_id: callId,
        tool_name: toolName,
        summary,
        file_path: filePath,
      });
    });
  }

  /**
   * 组装设置页 Skill 快照：当前注册表 Skill 列表、配置来源与安装目标提示。
   *
   * @param deps 设置面板依赖（读取配置来源）
   * @returns 设置页 Skill 列表 payload
   */
  private _buildSkillsPayload(deps: SettingsPanelDeps): {
    skills: { name: string; description: string; sourcePath?: string }[];
    source: SyncSource;
    directories: string[];
    installTarget?: string;
  } {
    const skills = (this._skillRegistry?.list() ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      sourcePath: s.sourcePath,
    }));
    const folders = vscode.workspace.workspaceFolders ?? [];
    const installTarget = folders.length > 0
      ? `.claude/skills/<skill-name>/SKILL.md`
      : undefined;
    return { skills, source: deps.getSyncSource(), directories: deps.getSkillDirectories(), installTarget };
  }

  /**
   * 处理设置面板消息：模型配置读取/保存、Skill 列表读取、来源切换与安装。
   * 密钥永不回传；校验失败返回可显示的 settingsError。
   *
   * @param panel 设置面板
   * @param msg Webview 消息
   */
  private async _handleSettingsMessage(
    panel: vscode.WebviewPanel,
    msg: { command: string; [key: string]: unknown }
  ): Promise<void> {
    const deps = this._settingsDeps;
    logger.log(`[ChatPanel] 收到设置面板消息: ${msg.command}`);
    if (!deps) {
      panel.webview.postMessage({ command: 'settingsError', message: '设置面板依赖未就绪' });
      return;
    }

    switch (msg.command) {
      case 'requestModelSettings': {
        const view = await deps.modelStore.getSettingsView();
        panel.webview.postMessage({ command: 'modelSettings', model: view });
        break;
      }
      case 'saveModelSettings': {
        try {
          const config = await deps.modelStore.save(msg.model as ModelSettingsInput);
          deps.onModelConfigSaved?.(config);
          panel.webview.postMessage({
            command: 'modelSettingsSaved',
            model: await deps.modelStore.getSettingsView(),
          });
        } catch (err) {
          panel.webview.postMessage({
            command: 'settingsError',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case 'setDefaultModel': {
        try {
          deps.onModelConfigSaved?.(await deps.modelStore.setDefaultModel(msg.modelId as string));
          panel.webview.postMessage({ command: 'modelSettingsSaved', model: await deps.modelStore.getSettingsView() });
        } catch (err) {
          panel.webview.postMessage({ command: 'settingsError', message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      case 'setModelEnabled': {
        try {
          await deps.modelStore.setModelEnabled(msg.modelId as string, msg.enabled === true);
          panel.webview.postMessage({ command: 'modelSettingsSaved', model: await deps.modelStore.getSettingsView() });
        } catch (err) {
          panel.webview.postMessage({ command: 'settingsError', message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      case 'deleteModel': {
        try {
          await deps.modelStore.deleteModel(msg.modelId as string);
          panel.webview.postMessage({ command: 'modelSettingsSaved', model: await deps.modelStore.getSettingsView() });
        } catch (err) {
          panel.webview.postMessage({ command: 'settingsError', message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      case 'requestSkills': {
        panel.webview.postMessage({ command: 'skillsList', ...this._buildSkillsPayload(deps) });
        break;
      }
      case 'setSyncSource': {
        try {
          await deps.setSyncSource(msg.source as SyncSource);
          // 扩展侧已完成 Skill 重新同步，推送最新快照
          panel.webview.postMessage({ command: 'skillsList', ...this._buildSkillsPayload(deps) });
        } catch (err) {
          panel.webview.postMessage({
            command: 'settingsError',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case 'setSkillDirectories': {
        try {
          const directories = Array.isArray(msg.directories)
            ? msg.directories.filter((entry): entry is string => typeof entry === 'string')
            : [];
          await deps.setSkillDirectories(directories);
          panel.webview.postMessage({ command: 'skillsList', ...this._buildSkillsPayload(deps) });
        } catch (err) {
          panel.webview.postMessage({
            command: 'settingsError',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case 'uploadSkillArchive': {
        const result = await deps.uploadSkillArchive();
        if (result.ok) {
          // 安装成功后扩展侧已重新同步并刷新斜杠菜单，推送最新快照
          panel.webview.postMessage({ command: 'skillsList', ...this._buildSkillsPayload(deps) });
        } else {
          panel.webview.postMessage({ command: 'settingsError', message: result.reason });
        }
        break;
      }
    }
  }

  /**
   * 处理聊天 Webview 消息并调用对应的会话、文件或设置能力。
   *
   * @param msg Webview 发送的协议消息
   * @returns Promise<void>
   */
  private async _handleMessage(msg: { command: string;[key: string]: unknown }): Promise<void> {
    const webview = this._chatWebview;
    if (!webview) { return; }

    logger.log(`[ChatPanel] 收到 webview 消息: ${msg.command}`);

    const guardedCommands = new Set([
      'createSession',
      'sendMessage',
      'stopStream',
      'loadHistory',
      'requestSlashCommands',
      'requestWorkspaceFiles',
      'renameSession',
      'requestSessions',
      'openSession',
      'deleteSession',
    ]);
    if (this._runtimeStatus !== 'ready' && guardedCommands.has(msg.command)) {
      logger.log(`[ChatPanel] 运行时未就绪，忽略业务消息 command=${msg.command} status=${this._runtimeStatus}`);
      return;
    }

    switch (msg.command) {
      case 'webviewReady': {
        // 握手：UI 挂载完成后先同步当前运行时状态，避免未就绪时触发聊天业务。
        this._pushRuntimeState(webview);
        if (this._runtimeStatus !== 'ready') {
          break;
        }
        const modelName = this._settingsDeps?.getModelName() ?? '';
        if (modelName) {
          webview.postMessage({ command: 'modelInfo', model: modelName });
        }
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
        webview.postMessage({ command: 'sessionCreated', sessionId });
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
      case 'switchModel': {
        // /model 命令：QuickPick 选择已启用模型并切换当前默认模型（复用设置页「设为默认」链路：持久化 + 重建 Provider）
        const deps = this._settingsDeps;
        if (!deps) {
          break;
        }
        try {
          const view = await deps.modelStore.getSettingsView();
          const enabled = (view.models ?? []).filter((m) => m.enabled);
          if (enabled.length === 0) {
            const choice = await vscode.window.showInformationMessage('尚未配置可用的模型，请先到设置页配置模型', '打开设置');
            if (choice === '打开设置') {
              this._showSettingsPanel();
            }
            break;
          }
          const picked = await vscode.window.showQuickPick(
            enabled.map((m) => ({
              label: m.model,
              description: m.provider,
              detail: m.isDefault ? '当前默认模型' : m.apiKeyConfigured ? '已配置 API Key' : '未配置 API Key',
              modelId: m.id,
            })),
            { placeHolder: '选择要切换的模型' }
          );
          if (!picked) {
            break; // 用户取消选择
          }
          const config = await deps.modelStore.setDefaultModel(picked.modelId);
          deps.onModelConfigSaved?.(config);
          logger.log(`[ChatPanel] /model 已切换默认模型 id=${picked.modelId} model=${picked.label}`);
        } catch (err) {
          logger.error(`[ChatPanel] /model 切换模型失败: ${err instanceof Error ? err.message : String(err)}`);
          vscode.window.showErrorMessage(`切换模型失败：${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case 'requestModelPicker': {
        const deps = this._settingsDeps;
        if (!deps) {
          break;
        }
        try {
          const view = await deps.modelStore.getSettingsView();
          const models = (view.models ?? [])
            .filter((model) => model.enabled)
            .map((model) => ({ id: model.id, model: model.model, provider: model.provider, isDefault: model.isDefault }));
          webview.postMessage({ command: 'modelPicker', models });
          logger.log(`[ChatPanel] 已返回模型弹窗候选项 count=${models.length}`);
        } catch (err) {
          logger.error(`[ChatPanel] 获取模型弹窗候选项失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case 'selectModel': {
        const deps = this._settingsDeps;
        const modelId = typeof msg.modelId === 'string' ? msg.modelId : '';
        if (!deps || !modelId) {
          logger.error(`[ChatPanel] 拒绝无效模型切换请求 modelId=${modelId || '空'}`);
          break;
        }
        try {
          const view = await deps.modelStore.getSettingsView();
          const selected = (view.models ?? []).find((model) => model.id === modelId && model.enabled);
          if (!selected) {
            throw new Error('未找到可用的目标模型');
          }
          const config = await deps.modelStore.setDefaultModel(modelId);
          deps.onModelConfigSaved?.(config);
          logger.log(`[ChatPanel] 模型弹窗已切换默认模型 id=${modelId} model=${selected.model}`);
        } catch (err) {
          logger.error(`[ChatPanel] 模型弹窗切换失败: ${err instanceof Error ? err.message : String(err)}`);
          vscode.window.showErrorMessage(`切换模型失败：${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case 'loadHistory': {
        const history = this._sessionManager.loadHistory(msg.sessionId as string);
        webview.postMessage({ command: 'historyLoaded', messages: history });
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
        this._pushSlashCommands(webview);
        break;
      }
      case 'requestWorkspaceFiles': {        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        if (workspaceFolders.length === 0) {
          webview.postMessage({ command: 'workspaceFiles', files: [] });
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
        webview.postMessage({ command: 'workspaceFiles', files });
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
        webview.postMessage({ command: 'sessionList', sessions });
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
            webview.postMessage({ command: 'currentSessionDeleted' });
          }
        }
        // 无论是否删除都回推最新列表，前端据此判断当前会话是否已被删除
        webview.postMessage({ command: 'sessionList', sessions: this._sessionManager.listSessions() });
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
