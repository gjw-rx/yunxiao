import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { ToolRegistry } from './core/toolRegistry';
import type { EventBus, AgentEvent } from './core/eventBus';
import type { LocalSessionManager } from './core/localSessionManager';
import type { SkillRegistry } from './skill/skillRegistry';
import type { ModelConfigStore, ModelSettingsInput } from './config/modelConfigStore';
import { isReasoningLevel } from './config/modelConfigStore';
import type { ModelConfig } from './config/modelConfig';
import type { SyncSource } from './config/syncConfig';
import type { SkillInstallResult } from './skill/skillInstaller';
import type { RuntimeStatus } from './webview-ui/protocol';
import type { SessionTodoStore } from './memory/sessionTodoStore';
import type { ChangeJournal } from './core/changeJournal';
import type { SessionPlanModeStore } from './core/planModeStore';
import type { PlanModeChangePayload } from './memory/planTypes';
import type { McpConfigStore } from './mcp/configStore';
import type { McpServerView } from './mcp/types';
import type { McpSaveMode, McpOperation, HooksConfigView, RtkStatusView } from './webview-ui/protocol';
import type { UsageGranularity, TokenUsageStatsResult } from './webview-ui/protocol';
import type { HooksConfigStore } from './hook/hooksConfigStore';
import type { RtkTransformHook } from './hook/rtkAdapter';
import { detectRtk, type RtkDetectionResult } from './hook/rtkDetector';
import { summarizeTodos, type TodoStateUpdate } from './memory/todoTypes';
import { buildSlashCommandGroups } from './chat/slashCommands';
import type { CommandStore, CommandInput } from './command/commandStore';
import type { CommandScope, CommandSnapshot } from './command/types';
import type { CommandInfo } from './webview-ui/protocol';
import { buildCommandMessage } from './command/commandMessage';
import { DEFAULT_MAX_FILE_SIZE, isBinaryExt, redactSecrets } from './tools/fs/readFile';
import { APPROVAL_MODE_CONFIG_KEY, isApprovalMode, type ApprovalMode } from './core/approvalGateway';
import * as logger from './logger';

/** 单个前后快照向 Webview 发送的最大字符数。 */
const MAX_CHANGE_REVIEW_FILE_CHARS = 100_000;

/**
 * 截断过大的文件快照，避免独立变更页消息超过 Webview 可承载范围。
 * @param text 原始快照文本。
 * @returns 可安全发送到 Webview 的文本。
 */
function truncateChangeReviewText(text: string): string {
  if (text.length <= MAX_CHANGE_REVIEW_FILE_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_CHANGE_REVIEW_FILE_CHARS)}\n\n… 内容已截断，仅展示前 ${MAX_CHANGE_REVIEW_FILE_CHARS} 个字符。`;
}

interface ChatViewDeps {
  readonly sessionManager: LocalSessionManager;
  readonly registry: ToolRegistry;
  readonly eventBus: EventBus;
  readonly todoStore?: SessionTodoStore;
  /** 会话代码变更日志。 */
  readonly changeJournal?: ChangeJournal;
  /** Plan 模式状态服务（可选；装配后向 Webview 回推 Plan 阶段与接收模式操作）。 */
  readonly planModeStore?: SessionPlanModeStore;
}

/** 设置面板依赖：模型存储、配置来源、Skill 安装与模型保存回调。 */
interface SettingsPanelDeps {
  /** 插件私有模型配置存储 */
  readonly modelStore: ModelConfigStore;
  /** 读取配置来源（none/claude/trae/agent） */
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
  /** MCP 私有配置存储；未装配时 MCP 写操作返回未就绪错误。 */
  readonly mcpStore?: McpConfigStore;
  /** 构建 MCP 设置快照（合并 Store 配置视图与 Manager 运行时状态）。 */
  readonly getMcpSnapshot?: () => Promise<readonly McpServerView[]>;
  /** MCP 配置持久化变更后通知运行时应用最新 revision（Manager 串行 applyConfig）。 */
  readonly onMcpConfigChanged?: () => void | Promise<void>;
  /** 请求重连指定 Server（Manager 重建 Connection，不改配置）。 */
  readonly onMcpReconnect?: (serverId: string) => void | Promise<void>;
  /** Hooks 配置 Store（未装配时 Hooks 写操作返回未就绪错误）。 */
  readonly hooksConfigStore?: HooksConfigStore;
  /** RTK 检测函数（默认 detectRtk；可注入供测试）。 */
  readonly detectRtk?: (executablePath: string) => Promise<RtkDetectionResult>;
  /** RTK Transform Hook（提供固定样例改写测试）。 */
  readonly rtkTransformHook?: RtkTransformHook;
  /** 请求当前工作区 token 用量统计（粒度 + 参考日期；结果含标准化区间与 partial 标记）。 */
  readonly requestUsageStats?: (granularity: UsageGranularity, reference: string) => Promise<TokenUsageStatsResult>;
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
  private readonly _todoStore?: SessionTodoStore;
  private readonly _changeJournal?: ChangeJournal;
  private readonly _planModeStore?: SessionPlanModeStore;
  /** 独立代码变更查看面板。 */
  private _changeReviewPanel?: vscode.WebviewPanel;
  /** 当前独立变更页所查看的会话与变更集。 */
  private _changeReviewTarget?: { readonly sessionId: string; readonly changeSetId: string };
  private _currentSessionId?: string;
  private _createSessionRequest = 0;
  private readonly _pendingApprovals = new Map<string, ApprovalResolver>();
  private _skillRegistry?: SkillRegistry;
  /** Command 管理服务（装配后提供注册表、双作用域快照与 CRUD）。 */
  private _commandStore?: CommandStore;
  private _settingsDeps?: SettingsPanelDeps;
  /** 最近一次 RTK 检测状态缓存（设置页快照复用）。 */
  private _rtkStatus?: RtkStatusView;
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
    this._todoStore = deps.todoStore;
    this._changeJournal = deps.changeJournal;
    this._planModeStore = deps.planModeStore;
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
   * 注入 Command 管理服务（装配完成后调用，用于斜杠菜单、设置页快照与发送展开）。
   *
   * @param commandStore Command 管理服务
   */
  setCommandStore(commandStore: CommandStore): void {
    this._commandStore = commandStore;
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
   * 获取当前工作区的有效审批模式，非法值按安全默认值处理。
   * @returns 当前有效审批模式。
   */
  private _getApprovalMode(): ApprovalMode {
    const mode = vscode.workspace.getConfiguration('yunxiaoAgent').get<unknown>(APPROVAL_MODE_CONFIG_KEY);
    if (mode === undefined || isApprovalMode(mode)) {
      return mode ?? 'request';
    }
    logger.error(`[ChatPanel] 审批模式配置无效，已回退 request value=${String(mode)}`);
    return 'request';
  }

  /**
   * 向聊天 Webview 推送当前工作区审批模式。
   * @param webview 接收审批模式的聊天 Webview。
   * @returns void。
   */
  private _pushApprovalMode(webview: vscode.Webview): void {
    webview.postMessage({ command: 'approvalMode', mode: this._getApprovalMode() });
  }

  /**
   * 保存当前工作区审批模式。
   * @param mode 待保存的有效审批模式。
   * @returns Promise<void>。
   */
  private async _setApprovalMode(mode: ApprovalMode): Promise<void> {
    await vscode.workspace.getConfiguration('yunxiaoAgent').update(
      APPROVAL_MODE_CONFIG_KEY,
      mode,
      vscode.ConfigurationTarget.Workspace,
    );
    logger.log(`[ChatPanel] 审批模式已保存 mode=${mode}`);
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
      groups: buildSlashCommandGroups(this._skillRegistry, this._commandStore?.registry),
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
   * 将当前生效模型名称、模型 ID 与推理强度推送到已打开的对话面板。
   * 从模型存储读取非敏感快照，不携带 API Key / baseURL 等敏感连接信息。
   *
   * @returns Promise<void>
   */
  async refreshModelInfo(): Promise<void> {
    const deps = this._settingsDeps;
    if (!this._chatWebview || !deps) {
      return;
    }
    const modelName = deps.getModelName() ?? '';
    if (!modelName) {
      return;
    }
    let modelId: string | undefined;
    let reasoningEffort: unknown;
    try {
      const view = await deps.modelStore.getSettingsView();
      modelId = view.defaultModelId;
      reasoningEffort = view.reasoningEffort;
    } catch (error) {
      logger.error(`[ChatPanel] 读取模型信息快照失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    this._chatWebview.postMessage({
      command: 'modelInfo',
      model: modelName,
      ...(modelId ? { modelId } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    logger.log(`[ChatPanel] 已刷新对话模型信息 model=${modelName} modelId=${modelId ?? '未配置'} reasoningEffort=${String(reasoningEffort ?? '未设置')}`);
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
      async (msg: { command: string;[key: string]: unknown }) => {
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
      case 'todo_state_change':
        webview.postMessage({ command: 'todoState', ...(e.payload as TodoStateUpdate) });
        break;
      case 'plan_mode_change':
        {
          const payload = e.payload as PlanModeChangePayload;
          webview.postMessage({
            command: 'planModeState',
            sessionId: e.sessionId,
            state: { stage: payload.to, draftCreated: payload.draftCreated },
          });
        }
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
		  reused?: boolean;
        };
        webview.postMessage({ command: 'toolState', ...p });
        break;
      }
      case 'tool_call': {
        const p = e.payload as { call_id: string; tool: string; args?: unknown };
        webview.postMessage({ command: 'toolCall', ...p });
        break;
      }
      case 'tool_result': {
        const p = e.payload as {
          call_id: string;
          status: string;
          result?: unknown;
          error?: string;
          metadata?: { reused?: boolean };
        };
        webview.postMessage({ command: 'toolResult', ...p, reused: p.metadata?.reused });
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
      case 'turn_change_set':
        webview.postMessage({ command: 'replyChangeSet', changeSet: e.payload });
        break;
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
   * 组装设置页双作用域 Command 快照（不携带正文，仅非敏感元数据）。
   *
   * @param store Command 管理服务
   * @returns CommandsListMessage 的非 command 字段
   */
  private _buildCommandsPayload(store: CommandStore): {
    global: CommandInfo[];
    project: CommandInfo[];
    globalDirectory?: string;
    projectDirectory?: string;
    projectAvailable: boolean;
  } {
    const registry = store.registry;
    const toInfo = (command: { name: string; description?: string; scope: CommandScope; sourcePath: string }): CommandInfo => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      scope: command.scope,
      overridden: registry.isOverridden(command.name),
      sourcePath: command.sourcePath,
    });
    const globalDirectory = registry.getGlobalDirectory();
    const projectDirectory = registry.getProjectDirectory();
    return {
      global: registry.listGlobal().map(toInfo),
      project: registry.listProject().map(toInfo),
      ...(globalDirectory ? { globalDirectory } : {}),
      ...(projectDirectory ? { projectDirectory } : {}),
      projectAvailable: projectDirectory !== undefined,
    };
  }

  /**
   * 处理设置页 Command 写操作（create/update/delete/refresh）：成功后回推最新快照并刷新斜杠菜单。
   *
   * @param panel 设置面板
   * @param msg Webview 消息（scope/name/input）
   * @param kind 操作类别
   */
  private async _handleCommandWrite(
    panel: vscode.WebviewPanel,
    msg: { command: string; [key: string]: unknown },
    kind: 'create' | 'update' | 'delete' | 'refresh',
  ): Promise<void> {
    const store = this._commandStore;
    if (!store) {
      panel.webview.postMessage({ command: 'settingsError', message: 'Command 管理服务未就绪' });
      return;
    }
    const scope: CommandScope = msg.scope === 'project' ? 'project' : 'global';
    const startedAt = Date.now();
    try {
      let snapshot: CommandSnapshot;
      if (kind === 'refresh') {
        snapshot = await store.refresh();
      } else if (kind === 'create') {
        snapshot = await store.create(scope, msg.input as CommandInput);
      } else if (kind === 'update') {
        snapshot = await store.update(scope, msg.name as string, msg.input as CommandInput);
      } else {
        snapshot = await store.delete(scope, msg.name as string);
      }
      // 成功：设置页与聊天斜杠菜单共用同一份已完成的注册表快照
      panel.webview.postMessage({ command: 'commandsList', ...this._buildCommandsPayload(store) });
      this.refreshSlashCommands();
      logger.log(
        `[ChatPanel] Command ${kind} 成功 scope=${scope} 全局=${snapshot.global.commands.length} 项目=${snapshot.project?.commands.length ?? 0} 耗时=${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[ChatPanel] Command ${kind} 失败 scope=${scope} error=${message}`);
      panel.webview.postMessage({ command: 'settingsError', message });
    }
  }

  /**
   * 主动向已打开设置面板推送最新 Command 快照（激活/外部刷新后由扩展侧调用）。
   *
   * @returns Promise<void>
   */
  pushCommandsSnapshot(): void {
    const panel = this._settingsPanel;
    const store = this._commandStore;
    if (!panel || !store) {
      return;
    }
    panel.webview.postMessage({ command: 'commandsList', ...this._buildCommandsPayload(store) });
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
    msg: { command: string;[key: string]: unknown }
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
      case 'requestMcpSettings': {
        const servers = deps.getMcpSnapshot ? await deps.getMcpSnapshot() : [];
        panel.webview.postMessage({ command: 'mcpSettings', servers });
        break;
      }
      case 'saveMcpServersJson': {
        await this._handleSaveMcpServersJson(panel, msg, deps);
        break;
      }
      case 'setMcpServerEnabled': {
        await this._handleSetMcpServerEnabled(panel, msg, deps);
        break;
      }
      case 'reconnectMcpServer': {
        await this._handleReconnectMcpServer(panel, msg, deps);
        break;
      }
      case 'deleteMcpServer': {
        await this._handleDeleteMcpServer(panel, msg, deps);
        break;
      }
      case 'requestHooksSnapshot': {
        await this._postHooksSnapshot(panel, deps);
        break;
      }
      case 'saveHooksConfig': {
        await this._handleSaveHooksConfig(panel, msg, deps);
        break;
      }
      case 'detectRtk': {
        await this._handleDetectRtk(panel, deps);
        break;
      }
      case 'testRtkRewrite': {
        await this._handleTestRtkRewrite(panel, deps);
        break;
      }
      case 'requestUsageStats': {
        await this._handleRequestUsageStats(panel, msg);
        break;
      }
      case 'requestCommands': {
        const store = this._commandStore;
        if (!store) {
          panel.webview.postMessage({ command: 'settingsError', message: 'Command 管理服务未就绪' });
          break;
        }
        panel.webview.postMessage({ command: 'commandsList', ...this._buildCommandsPayload(store) });
        break;
      }
      case 'createCommand': {
        await this._handleCommandWrite(panel, msg, 'create');
        break;
      }
      case 'updateCommand': {
        await this._handleCommandWrite(panel, msg, 'update');
        break;
      }
      case 'deleteCommand': {
        await this._handleCommandWrite(panel, msg, 'delete');
        break;
      }
      case 'refreshCommands': {
        await this._handleCommandWrite(panel, msg, 'refresh');
        break;
      }
    }
  }

  /**
   * 处理设置页使用情况请求：注入统计服务，按粒度与参考日期聚合并回传标准化区间。
   * 入口、成功与失败分支均记录含粒度、区间、模型数与耗时等可定位日志；整体失败回传有界错误。
   *
   * @param panel 设置面板
   * @param msg Webview 消息（granularity/reference）
   */
  private async _handleRequestUsageStats(
    panel: vscode.WebviewPanel,
    msg: { command: string;[key: string]: unknown },
  ): Promise<void> {
    const deps = this._settingsDeps;
    if (!deps?.requestUsageStats) {
      panel.webview.postMessage({ command: 'usageStatsError', message: '用量统计服务未就绪' });
      return;
    }
    const granularity: UsageGranularity = msg.granularity === 'week' || msg.granularity === 'month' ? msg.granularity : 'day';
    const reference = typeof msg.reference === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(msg.reference)
      ? msg.reference
      : new Date().toISOString().slice(0, 10);
    const startedAt = Date.now();
    logger.log(`[ChatPanel] 使用情况请求 granularity=${granularity} reference=${reference}`);
    try {
      const payload = await deps.requestUsageStats(granularity, reference);
      logger.log(
        `[ChatPanel] 使用情况响应 granularity=${granularity} start=${payload.start} end=${payload.end} 模型数=${payload.models.length} partial=${payload.partial} 耗时=${Date.now() - startedAt}ms`,
      );
      panel.webview.postMessage({ command: 'usageStats', payload });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`[ChatPanel] 使用情况统计失败 granularity=${granularity} reference=${reference}: ${reason}`);
      panel.webview.postMessage({ command: 'usageStatsError', message: '用量统计失败，请重试' });
    }
  }

  /**
   * 发送 MCP 设置错误到设置面板（统一错误消息形状，携带可选字段路径）。
   *
   * @param panel 设置面板
   * @param operation 触发错误的操作类别
   * @param message 可读错误消息（不含秘密/堆栈）
   * @param fieldPath 可选字段路径，定位到 `mcpServers.<id>.<field>`
   */
  private _postMcpError(
    panel: vscode.WebviewPanel,
    operation: McpOperation,
    message: string,
    fieldPath?: string,
  ): void {
    panel.webview.postMessage({ command: 'mcpSettingsError', operation, message, fieldPath });
  }

  /**
   * 处理 MCP JSON 保存（add/edit）：Host 重新校验 mode 与 editingServerId，
   * 调用 Store 事务保存；成功通知运行时应用并回推最新快照，失败返回带 fieldPath 的错误。
   *
   * @param panel 设置面板
   * @param msg Webview 消息（json/mode/editingServerId）
   * @param deps 设置面板依赖
   */
  private async _handleSaveMcpServersJson(
    panel: vscode.WebviewPanel,
    msg: { command: string;[key: string]: unknown },
    deps: SettingsPanelDeps,
  ): Promise<void> {
    const operation: McpOperation = 'save';
    if (!deps.mcpStore) {
      this._postMcpError(panel, operation, 'MCP 配置存储未就绪');
      return;
    }
    const json = typeof msg.json === 'string' ? msg.json : '';
    const mode: McpSaveMode = msg.mode === 'edit' ? 'edit' : 'add';
    const editingServerId = typeof msg.editingServerId === 'string' ? msg.editingServerId : undefined;
    if (mode === 'edit' && !editingServerId) {
      this._postMcpError(panel, operation, '编辑模式缺少 editingServerId');
      return;
    }
    const result = mode === 'edit'
      ? await deps.mcpStore.saveEdit(editingServerId!, json)
      : await deps.mcpStore.saveAddImport(json);
    if (!result.ok) {
      const first = result.errors[0];
      this._postMcpError(panel, operation, first?.message ?? '保存失败', first?.fieldPath);
      return;
    }
    logger.log(`[ChatPanel] MCP 配置已保存 mode=${mode} revision=${result.revision} servers=${Object.keys(result.servers).length}`);
    await deps.onMcpConfigChanged?.();
    const servers = deps.getMcpSnapshot ? await deps.getMcpSnapshot() : [];
    panel.webview.postMessage({ command: 'mcpSettingsSaved', servers });
  }

  /**
   * 处理 MCP Server 启停：校验 serverId，持久化 enabled，通知运行时并回推操作已接受。
   * 最终连接状态以后续 mcpSettings 快照为准。
   *
   * @param panel 设置面板
   * @param msg Webview 消息（serverId/enabled）
   * @param deps 设置面板依赖
   */
  private async _handleSetMcpServerEnabled(
    panel: vscode.WebviewPanel,
    msg: { command: string;[key: string]: unknown },
    deps: SettingsPanelDeps,
  ): Promise<void> {
    const operation: McpOperation = 'setEnabled';
    if (!deps.mcpStore) {
      this._postMcpError(panel, operation, 'MCP 配置存储未就绪');
      return;
    }
    const serverId = typeof msg.serverId === 'string' ? msg.serverId : '';
    if (!serverId) {
      this._postMcpError(panel, operation, '缺少 serverId');
      return;
    }
    const enabled = msg.enabled === true;
    const result = await deps.mcpStore.setEnabled(serverId, enabled);
    if (!result.ok) {
      this._postMcpError(panel, operation, result.error ?? '操作失败');
      return;
    }
    logger.log(`[ChatPanel] MCP 启停已保存 serverId=${serverId} enabled=${enabled} revision=${result.revision}`);
    await deps.onMcpConfigChanged?.();
    panel.webview.postMessage({ command: 'mcpOperationAccepted', serverId, operation });
  }

  /**
   * 处理 MCP Server 重连：校验 serverId，通知 Manager 重建连接，回推操作已接受。
   * 重连不改配置，最终状态以后续 mcpSettings 快照为准。
   *
   * @param panel 设置面板
   * @param msg Webview 消息（serverId）
   * @param deps 设置面板依赖
   */
  private async _handleReconnectMcpServer(
    panel: vscode.WebviewPanel,
    msg: { command: string;[key: string]: unknown },
    deps: SettingsPanelDeps,
  ): Promise<void> {
    const operation: McpOperation = 'reconnect';
    const serverId = typeof msg.serverId === 'string' ? msg.serverId : '';
    if (!serverId) {
      this._postMcpError(panel, operation, '缺少 serverId');
      return;
    }
    logger.log(`[ChatPanel] MCP 重连请求已接受 serverId=${serverId}`);
    await deps.onMcpReconnect?.(serverId);
    panel.webview.postMessage({ command: 'mcpOperationAccepted', serverId, operation });
  }

  /**
   * 处理 MCP Server 删除：校验 serverId，持久化删除并清理 Secrets，
   * 通知运行时下线，回推不含已删除 Server 的最新快照。
   *
   * @param panel 设置面板
   * @param msg Webview 消息（serverId）
   * @param deps 设置面板依赖
   */
  private async _handleDeleteMcpServer(
    panel: vscode.WebviewPanel,
    msg: { command: string;[key: string]: unknown },
    deps: SettingsPanelDeps,
  ): Promise<void> {
    const operation: McpOperation = 'delete';
    if (!deps.mcpStore) {
      this._postMcpError(panel, operation, 'MCP 配置存储未就绪');
      return;
    }
    const serverId = typeof msg.serverId === 'string' ? msg.serverId : '';
    if (!serverId) {
      this._postMcpError(panel, operation, '缺少 serverId');
      return;
    }
    const result = await deps.mcpStore.delete(serverId);
    if (!result.ok) {
      this._postMcpError(panel, operation, result.error ?? '删除失败');
      return;
    }
    logger.log(`[ChatPanel] MCP Server 已删除 serverId=${serverId}`);
    await deps.onMcpConfigChanged?.();
    const servers = deps.getMcpSnapshot ? await deps.getMcpSnapshot() : [];
    panel.webview.postMessage({ command: 'mcpSettingsSaved', servers });
  }

  /**
   * 主动向设置面板推送 MCP 状态快照（运行时状态/工具变化时调用）。
   * 设置面板关闭或未打开、或未装配快照构建器时安全跳过，不抛错。
   */
  async pushMcpSnapshot(): Promise<void> {
    const panel = this._settingsPanel;
    const deps = this._settingsDeps;
    if (!panel || !deps?.getMcpSnapshot) {
      return;
    }
    const servers = await deps.getMcpSnapshot();
    panel.webview.postMessage({ command: 'mcpSettings', servers });
  }

  /**
   * 向设置面板推送 Hooks 快照（配置 + RTK 运行状态）。
   *
   * @param panel 设置面板
   * @param deps 设置面板依赖
   * @returns Promise<void>
   */
  private async _postHooksSnapshot(
    panel: vscode.WebviewPanel,
    deps: SettingsPanelDeps
  ): Promise<void> {
    const config = this._buildHooksConfigView(deps);
    panel.webview.postMessage({ command: 'hooksSnapshot', config, rtk: this._rtkStatus });
  }

  /**
   * 处理 Hooks 配置保存：运行时校验所有入站字段（enabled/rtkEnabled 必须为 boolean，
   * rtkExecutablePath 必须为字符串或缺失），保存后清除过期 RTK 检测缓存并回推快照。
   *
   * @param panel 设置面板
   * @param msg Webview 消息（enabled/rtkEnabled/rtkExecutablePath）
   * @param deps 设置面板依赖
   * @returns Promise<void>
   */
  private async _handleSaveHooksConfig(
    panel: vscode.WebviewPanel,
    msg: { command: string;[key: string]: unknown },
    deps: SettingsPanelDeps
  ): Promise<void> {
    if (!deps.hooksConfigStore) {
      panel.webview.postMessage({ command: 'settingsError', message: 'Hooks 配置存储未就绪' });
      return;
    }
    if (typeof msg.enabled !== 'boolean' || typeof msg.rtkEnabled !== 'boolean') {
      panel.webview.postMessage({ command: 'settingsError', message: 'Hooks 配置字段非法' });
      return;
    }
    const pathValue =
      typeof msg.rtkExecutablePath === 'string' && msg.rtkExecutablePath.trim().length > 0
        ? msg.rtkExecutablePath.trim()
        : undefined;
    await deps.hooksConfigStore.save({
      enabled: msg.enabled,
      rtk: {
        enabled: msg.rtkEnabled,
        ...(pathValue ? { executablePath: pathValue } : {}),
      },
    });
    logger.log(`[ChatPanel] Hooks 配置已保存 enabled=${msg.enabled} rtkEnabled=${msg.rtkEnabled} rtkPath=${pathValue ? '已配置' : '未配置'}`);
    // 路径变更后旧检测结果失效
    this._rtkStatus = undefined;
    await this._postHooksSnapshot(panel, deps);
  }

  /**
   * 处理 RTK 重新检测：读取当前配置路径并调用检测函数，缓存有界状态后回推快照。
   *
   * @param panel 设置面板
   * @param deps 设置面板依赖
   * @returns Promise<void>
   */
  private async _handleDetectRtk(
    panel: vscode.WebviewPanel,
    deps: SettingsPanelDeps
  ): Promise<void> {
    const path = deps.hooksConfigStore?.get().rtk.executablePath;
    if (!path) {
      panel.webview.postMessage({ command: 'settingsError', message: '请先配置 RTK 可执行文件路径' });
      return;
    }
    logger.log(`[ChatPanel] 开始检测 RTK path=${path}`);
    const result = await (deps.detectRtk ?? detectRtk)(path);
    this._rtkStatus = {
      available: result.available,
      version: result.version,
      error: result.error,
      lastDetectedAt: Date.now(),
    };
    logger.log(`[ChatPanel] RTK 检测完成 available=${result.available} version=${result.version ?? 'unknown'} error=${result.error ?? '无'}`);
    await this._postHooksSnapshot(panel, deps);
  }

  /**
   * 处理固定样例改写测试：调用 RTK Transform Hook 的 testRewrite（仅请求改写 git status，
   * 不执行实际 Git 命令），回推测试结果消息。
   *
   * @param panel 设置面板
   * @param deps 设置面板依赖
   * @returns Promise<void>
   */
  private async _handleTestRtkRewrite(
    panel: vscode.WebviewPanel,
    deps: SettingsPanelDeps
  ): Promise<void> {
    if (!deps.rtkTransformHook) {
      panel.webview.postMessage({ command: 'settingsError', message: 'RTK Hook 未就绪' });
      return;
    }
    const result = await deps.rtkTransformHook.testRewrite();
    logger.log(`[ChatPanel] RTK 样例测试完成 sample=${result.sample} rewritten=${result.rewritten ?? '无'} error=${result.error ?? '无'}`);
    panel.webview.postMessage({
      command: 'hooksTestResult',
      sample: result.sample,
      ...(result.rewritten ? { rewritten: result.rewritten } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  }

  /**
   * 从配置 Store 构造设置页非敏感 Hooks 配置视图。
   *
   * @param deps 设置面板依赖
   * @returns Hooks 配置视图（未装配 Store 时返回安全默认值）
   */
  private _buildHooksConfigView(deps: SettingsPanelDeps): HooksConfigView {
    const config = deps.hooksConfigStore?.get();
    const view: HooksConfigView = {
      enabled: config?.enabled ?? true,
      rtkEnabled: config?.rtk.enabled ?? false,
      ...(config?.rtk.executablePath ? { rtkExecutablePath: config.rtk.executablePath } : {}),
    };
    return view;
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
      'deleteMessage',
      'rollbackTurn',
      'enterPlanMode',
      'continuePlanning',
      'exitPlanMode',
      'confirmExecution',
    ]);
    if (this._runtimeStatus !== 'ready' && guardedCommands.has(msg.command)) {
      logger.log(`[ChatPanel] 运行时未就绪，忽略业务消息 command=${msg.command} status=${this._runtimeStatus}`);
      return;
    }

    switch (msg.command) {
      case 'webviewReady': {
        // 握手：UI 挂载完成后先同步当前运行时状态，避免未就绪时触发聊天业务。
        this._pushRuntimeState(webview);
        this._pushApprovalMode(webview);
        if (this._runtimeStatus !== 'ready') {
          break;
        }
        const modelName = this._settingsDeps?.getModelName() ?? '';
        if (modelName) {
          await this.refreshModelInfo();
        }
        break;
      }
      case 'setApprovalMode': {
        const mode = msg.mode;
        if (!isApprovalMode(mode)) {
          logger.error(`[ChatPanel] 拒绝无效审批模式请求 mode=${String(mode)}`);
          this._pushApprovalMode(webview);
          break;
        }
        try {
          await this._setApprovalMode(mode);
          this._pushApprovalMode(webview);
        } catch (error) {
          logger.error(`[ChatPanel] 保存审批模式失败 mode=${mode} error=${error instanceof Error ? error.message : String(error)}`);
          this._pushApprovalMode(webview);
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
        // Command 引用：仅信任名称/作用域标识，不信任 Webview 传入的任何正文；正文由 Host 从最新注册表解析
        const rawCommand = msg.commandRef;
        const commandRef =
          rawCommand && typeof rawCommand === 'object' && typeof (rawCommand as { name?: unknown }).name === 'string'
            ? {
                name: (rawCommand as { name: string }).name,
                scope: (rawCommand as { scope?: string }).scope === 'project' ? ('project' as const) : ('global' as const),
              }
            : undefined;
        if (userText.trim() === '/compact' && files.length === 0 && skills.length === 0 && !commandRef) {
          try {
            const result = await this._sessionManager.compactContext(sessionId);
            const message = result.status === 'compacted'
              ? '上下文压缩完成'
              : result.status === 'skipped'
                ? '当前没有可压缩的上下文'
                : `上下文压缩失败：${result.error ?? '未知错误'}`;
            logger.log(`[ChatPanel] /compact 完成 sessionId=${sessionId} status=${result.status}`);
            void vscode.window.showInformationMessage(message);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`[ChatPanel] /compact 失败 sessionId=${sessionId} error=${message}`);
            void vscode.window.showWarningMessage(message);
          }
          break;
        }
        // 发送时从最新有效注册表重新解析 Command；缺失则拒绝本次发送，不追加用户消息
        const command = commandRef?.name ? this._commandStore?.registry.get(commandRef.name) : undefined;
        if (commandRef?.name && !command) {
          const message = `命令 /${commandRef.name} 已不存在或无效，请刷新后重新选择`;
          webview.postMessage({ command: 'error', message });
          logger.log(`[ChatPanel] 拒绝发送失效 Command sessionId=${sessionId} name=${commandRef.name}`);
          break;
        }
        let text: string;
        if (command) {
          // Command 展开块位于文件上下文之后、Skill 引用与用户补充说明之前
          const contextBlock = files.length > 0 ? await this._buildFileContext(files) : undefined;
          const skillBlock = skills.length > 0 ? skills.map((name) => `/${name}`).join('\n') : undefined;
          text = buildCommandMessage({ command, userText, fileContext: contextBlock, skillBlock });
        } else {
          text = userText;
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
      case 'enterPlanMode':
      case 'continuePlanning':
      case 'exitPlanMode':
      case 'confirmExecution': {
        // Plan 模式宿主动作：校验当前会话/阶段后执行，失败提示用户并回推最新状态保持一致
        const sessionId = msg.sessionId as string;
        if (!sessionId || sessionId !== this._currentSessionId) {
          logger.log(`[ChatPanel] 忽略过期 Plan 动作 command=${msg.command} sessionId=${sessionId}`);
          if (this._currentSessionId) {
            this._pushPlanMode(webview, this._currentSessionId);
          }
          break;
        }
        try {
          if (msg.command === 'enterPlanMode') {
            this._sessionManager.enterPlanMode(sessionId);
          } else if (msg.command === 'continuePlanning') {
            this._sessionManager.continuePlanning(sessionId);
          } else if (msg.command === 'exitPlanMode') {
            this._sessionManager.exitPlanMode(sessionId);
          } else {
            this._sessionManager.confirmExecution(sessionId);
          }
          logger.log(`[ChatPanel] Plan 动作 ${msg.command} 完成 sessionId=${sessionId}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`[ChatPanel] Plan 动作 ${msg.command} 失败 sessionId=${sessionId} error=${message}`);
          void vscode.window.showWarningMessage(message);
        }
        this._pushPlanMode(webview, sessionId);
        break;
      }
      case 'compactContext': {
        try {
          const result = await this._sessionManager.compactContext(msg.sessionId as string);
          const message = result.status === 'compacted'
            ? '上下文压缩完成'
            : result.status === 'skipped'
              ? '当前没有可压缩的上下文'
              : `上下文压缩失败：${result.error ?? '未知错误'}`;
          logger.log(`[ChatPanel] 手动压缩完成 sessionId=${msg.sessionId} status=${result.status}`);
          void vscode.window.showInformationMessage(message);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`[ChatPanel] 手动压缩失败 sessionId=${msg.sessionId} error=${message}`);
          void vscode.window.showWarningMessage(message);
        }
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
            .map((model) => ({
              id: model.id,
              model: model.model,
              provider: model.provider,
              isDefault: model.isDefault,
              ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
            }));
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
      case 'selectReasoningLevel': {
        const deps = this._settingsDeps;
        const modelId = typeof msg.modelId === 'string' ? msg.modelId : '';
        const level = msg.level;
        if (!deps || !modelId || !isReasoningLevel(level)) {
          logger.error(`[ChatPanel] 拒绝无效推理强度请求 modelId=${modelId || '空'} level=${String(level)}`);
          break;
        }
        try {
          // 重新校验目标模型仍是当前默认且已启用，再持久化并应用运行配置
          const config = await deps.modelStore.setReasoningEffort(modelId, level);
          deps.onModelConfigSaved?.(config);
          await this.refreshModelInfo();
          logger.log(`[ChatPanel] 推理强度已更新 modelId=${modelId} level=${level}`);
        } catch (err) {
          logger.error(`[ChatPanel] 设置推理强度失败 modelId=${modelId} level=${String(level)}: ${err instanceof Error ? err.message : String(err)}`);
          vscode.window.showErrorMessage(`设置推理强度失败：${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case 'loadHistory': {
        const sessionId = msg.sessionId as string;
        this._pushHistory(webview, sessionId);
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
      case 'openChangeReview': {
        const sessionId = msg.sessionId as string;
        const changeSetId = msg.changeSetId as string;
        if (sessionId && changeSetId) {
          this._openChangeReview(sessionId, changeSetId);
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
      case 'requestWorkspaceFiles': {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
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
      case 'deleteMessage': {
        // 删除单条消息（含配对补删），处理后回推最新历史刷新前端
        const sessionId = msg.sessionId as string;
        const seq = msg.seq as number;
        if (!sessionId || typeof seq !== 'number') {
          break;
        }
        logger.log(`[ChatPanel] 删除消息 sessionId=${sessionId} seq=${seq}`);
        this._sessionManager.deleteMessage(sessionId, seq);
        this._pushHistory(webview, sessionId);
        break;
      }
      case 'rollbackTurn': {
        // 回滚用户输入 turn：确认后恢复文件 + 截断消息，回推最新历史并回填输入框
        const sessionId = msg.sessionId as string;
        const seq = msg.seq as number;
        if (!sessionId || typeof seq !== 'number') {
          break;
        }
        const confirm = await vscode.window.showWarningMessage(
          '回滚将删除该消息及其后全部对话并复原相关文件改动，该操作不可恢复。确定继续？',
          { modal: true },
          '回滚'
        );
        if (confirm === '回滚') {
          try {
            const text = await this._sessionManager.rollbackTurn(sessionId, seq);
            webview.postMessage({ command: 'rollbackRestored', text });
          } catch (err) {
            logger.error(`[ChatPanel] 回滚失败 sessionId=${sessionId} seq=${seq} error=${err instanceof Error ? err.message : String(err)}`);
            vscode.window.showErrorMessage(`回滚失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // 无论是否确认都回推最新历史，前端据此刷新（取消时内容不变）
        this._pushHistory(webview, sessionId);
        break;
      }
    }
  }

  /**
   * 回推会话最新历史与任务快照（删除消息 / 回滚 / 加载历史后刷新前端）。
   * @param webview 聊天面板 webview
   * @param sessionId 会话 ID
   * @returns 无返回值
   */
  private _pushHistory(webview: vscode.Webview, sessionId: string): void {
    const history = this._sessionManager.loadHistory(sessionId);
    webview.postMessage({ command: 'historyLoaded', messages: history });
    if (this._todoStore) {
      const snapshot = this._todoStore.read(sessionId);
      webview.postMessage({ command: 'todoState', snapshot, summary: summarizeTodos(snapshot) });
    }
    // 历史刷新时回推对应会话的 Plan 状态（初始化/切换会话/删除消息后的刷新共用）
    this._pushPlanMode(webview, sessionId);
  }

  /**
   * 向 Webview 回推指定会话的 Plan 模式状态。
   * @param webview 聊天面板 webview。
   * @param sessionId 会话 ID。
   * @returns 无返回值
   */
  private _pushPlanMode(webview: vscode.Webview, sessionId: string): void {
    if (!this._planModeStore) {
      return;
    }
    webview.postMessage({
      command: 'planModeState',
      sessionId,
      state: this._planModeStore.getState(sessionId),
    });
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
  /**
   * 打开或复用独立的代码变更查看面板。
   * @param sessionId 来源会话 ID。
   * @param changeSetId 要查看的变更集 ID。
   * @returns void。
   */
  private _openChangeReview(sessionId: string, changeSetId: string): void {
    this._changeReviewTarget = { sessionId, changeSetId };
    if (this._changeReviewPanel) {
      this._changeReviewPanel.reveal(vscode.ViewColumn.Active);
      void this._pushChangeReviewSummary(this._changeReviewPanel.webview);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'yunxiaoAgent.changeReviewPanel',
      '代码变更',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this._context.extensionPath, 'dist')),
          vscode.Uri.file(path.join(this._context.extensionPath, 'media')),
        ],
      },
    );
    panel.iconPath = vscode.Uri.file(path.join(this._context.extensionPath, 'media', 'icon.png'));
    panel.webview.html = this._getHtml(panel.webview, 'change-review');
    panel.webview.onDidReceiveMessage(async (msg: { command: string; fileId?: string }) => {
      if (msg.command === 'requestChangeReview') {
        await this._pushChangeReviewSummary(panel.webview);
      } else if (msg.command === 'requestChangeReviewFile' && msg.fileId) {
        await this._pushChangeReviewFile(panel.webview, msg.fileId);
      }
    }, undefined, this._context.subscriptions);
    panel.onDidDispose(() => {
      if (this._changeReviewPanel === panel) {
        this._changeReviewPanel = undefined;
      }
      logger.log('[ChatPanel] 代码变更面板已关闭');
    }, undefined, this._context.subscriptions);
    this._changeReviewPanel = panel;
    logger.log(`[ChatPanel] 打开代码变更面板 sessionId=${sessionId} changeSetId=${changeSetId}`);
  }

  /**
   * 向独立代码变更面板发送当前目标的文件概览。
   * @param webview 接收消息的 Webview。
   * @returns 完成 Promise。
   */
  private async _pushChangeReviewSummary(webview: vscode.Webview): Promise<void> {
    const target = this._changeReviewTarget;
    const summary = target && this._changeJournal
      ? await this._changeJournal.getSummary(target.sessionId, target.changeSetId)
      : undefined;
    webview.postMessage({ command: 'changeReviewSummary', summary });
  }

  /**
   * 向独立代码变更面板发送一个文件的前后快照。
   * @param webview 接收消息的 Webview。
   * @param fileId 文件稳定标识。
   * @returns 完成 Promise。
   */
  private async _pushChangeReviewFile(webview: vscode.Webview, fileId: string): Promise<void> {
    const target = this._changeReviewTarget;
    const file = target && this._changeJournal
      ? await this._changeJournal.getFileDetail(target.sessionId, target.changeSetId, fileId)
      : undefined;
    webview.postMessage({
      command: 'changeReviewFile',
      file: file ? {
        ...file,
        before: truncateChangeReviewText(file.before),
        after: truncateChangeReviewText(file.after),
      } : undefined,
    });
  }

  private _getHtml(webview: vscode.Webview, page: 'chat' | 'settings' | 'change-review' = 'chat'): string {
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
    <title>${page === 'settings' ? '云效 Agent 设置' : page === 'change-review' ? '代码变更' : '云效 Agent'}</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body data-view="${page}">
  <div id="root"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
