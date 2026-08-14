/**
 * Webview 设置页组件。
 *
 * 职责：通过受控消息协议与扩展宿主交互——
 * - 模型分类：加载并保存模型配置（API Key 仅显示"已配置"状态，密钥不回传页面）
 * - Skill 分类：展示已加载 Skill 列表与来源，切换配置来源，安装项目 Skill 并展示反馈
 * - 使用情况分类：保持静态占位（不请求真实 token、费用或账户数据）
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { post, subscribe } from '../../bridge/vscode';
import type {
	HostToWebviewMessage,
	ModelSettingsInput,
	ModelSettingsView,
	McpServerView,
	McpServerStatus,
	McpSaveMode,
	SkillInfo,
	SyncSource,
} from '../../protocol';
import { MCP_SECRET_PLACEHOLDER } from '../../protocol';

/** 设置分类标识。 */
type SettingsSection = 'model' | 'skill' | 'mcp' | 'usage';

/** 设置分类导航项。 */
interface SettingsNavItem {
	/** 分类标识。 */
	readonly id: SettingsSection;
	/** 显示名称。 */
	readonly label: string;
}

/** 设置页分类列表（顺序：模型、Skill、MCP、使用情况）。 */
const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
	{ id: 'model', label: '模型' },
	{ id: 'skill', label: 'Skill' },
	{ id: 'mcp', label: 'MCP' },
	{ id: 'usage', label: '使用情况' },
];

/** 配置来源选项（四值互斥，默认 claude）。 */
const SOURCE_OPTIONS: readonly { value: SyncSource; label: string }[] = [
	{ value: 'claude', label: 'Claude' },
	{ value: 'trae', label: 'Trae' },
	{ value: 'agent', label: 'Agent' },
	{ value: 'none', label: '不加载' },
];

/** 设置分类图标。 */
function SettingsSectionIcon({ section }: { section: SettingsSection }): JSX.Element {
	if (section === 'model') {
		return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35"><path d="M3 4.5h10M3 8h10M3 11.5h10M5 3v3M11 6.5v3M7 10v3" /></svg>;
	}
	if (section === 'skill') {
		return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35"><path d="M8 1.7 9.4 5l3.4 1.4-3.4 1.4L8 11.1 6.6 7.8 3.2 6.4 6.6 5 8 1.7Z" /><path d="m12.1 10.2.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7.7-1.7Z" /></svg>;
	}
	if (section === 'mcp') {
		return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35"><path d="M2 4.5 8 2l6 2.5v7L8 14 2 11.5z" /><path d="M2 4.5 8 7l6-2.5M8 7v7" /></svg>;
	}
	return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35"><path d="M3 12V8m5 4V4m5 8V6" /><path d="M2 13.5h12" /></svg>;
}

/** 模型分类：受控表单，加载宿主返回的非敏感字段并支持保存（API Key 不回显明文）。 */
function ModelSettings({
	model,
	saving,
	onSave,
	onSetDefault,
	onSetEnabled,
	onDelete,
}: {
	/** 宿主返回的模型配置快照（加载中为 null） */
	model: ModelSettingsView | null;
	/** 是否保存中 */
	saving: boolean;
	/** 提交保存的回调 */
	onSave: (input: ModelSettingsInput) => void;
	/** 设置默认模型 */
	onSetDefault: (modelId: string) => void;
	/** 更新模型启用状态 */
	onSetEnabled: (modelId: string, enabled: boolean) => void;
	/** 删除模型 */
	onDelete: (modelId: string) => void;
}): JSX.Element {
	const [editingModelId, setEditingModelId] = useState<string | undefined>(undefined);
	const [isCreating, setIsCreating] = useState(false);
	const [provider, setProvider] = useState('');
	const [modelName, setModelName] = useState('');
	const [baseURL, setBaseURL] = useState('');
	const [temperature, setTemperature] = useState('0.7');
	const [maxTokens, setMaxTokens] = useState('4096');
	const [maxContextTokens, setMaxContextTokens] = useState('262144');
	const [runtime, setRuntime] = useState<'' | 'ai-sdk' | 'legacy'>('');
	const [apiKey, setApiKey] = useState('');

	const profiles = model?.models ?? [];
	const selectedProfile = isCreating ? undefined : profiles.find((profile) => profile.id === editingModelId) ?? profiles.find((profile) => profile.isDefault);
	const isFormOpen = isCreating || editingModelId !== undefined;
	const apiKeyConfigured = isCreating ? false : selectedProfile?.apiKeyConfigured ?? model?.apiKeyConfigured;
	// 宿主快照到达或选择模型后同步表单草稿（API Key 只显示状态，不填充明文）。
	useEffect(() => {
		if (!model || isCreating || !editingModelId) {
			return;
		}
		const current = profiles.find((profile) => profile.id === editingModelId);
		if (!current) {
			return;
		}
		setProvider(current.provider);
		setModelName(current.model);
		setBaseURL(current.baseURL);
		setTemperature(String(current.temperature));
		setMaxTokens(String(current.maxTokens));
		setMaxContextTokens(String(current.maxContextTokens ?? 262144));
		setRuntime(current.runtime ?? 'ai-sdk');
		setApiKey('');
	}, [model, profiles, editingModelId, isCreating]);

	/** 打开新增模型表单，并清空所有可编辑字段。 @returns 无返回值。 */
	const handleCreate = (): void => {
		setIsCreating(true);
		setEditingModelId(undefined);
		setProvider('');
		setModelName('');
		setBaseURL('');
		setTemperature('');
		setMaxTokens('');
		setMaxContextTokens('262144');
		setRuntime('');
		setApiKey('');
	};

	/** 打开指定模型的编辑表单。 @param modelId 模型配置 ID。 @returns 无返回值。 */
	const handleEdit = (modelId: string): void => {
		setIsCreating(false);
		setEditingModelId(modelId);
		setApiKey('');
	};

	const handleSave = (): void => {
		onSave({
			id: selectedProfile?.id,
			provider,
			model: modelName,
			baseURL,
			temperature: Number(temperature),
			maxTokens: Number(maxTokens),
			maxContextTokens: Number(maxContextTokens),
			runtime: runtime || undefined,
			// 仅在用户输入新 Key 时提交；空输入表示保持现状
			apiKey: apiKey.trim() ? apiKey.trim() : undefined,
		});
		setApiKey('');
	};

	return (
		<>
			<div className="settings-heading">
				<span className="settings-eyebrow">运行环境</span>
				<h1>模型</h1>
				<p>配置模型连接与生成偏好，保存后对后续新会话生效。</p>
			</div>
			<section className="settings-card settings-model-list-card" aria-label="已配置模型">
				<div className="settings-card-header settings-card-header-list">
					<div><h2>已配置模型</h2><p>选择默认模型，或启用、停用和编辑现有连接。</p></div>
					<button type="button" className="settings-add-model-btn" disabled={saving} onClick={handleCreate}>+ 添加模型</button>
				</div>
				{profiles.length === 0 ? <div className="settings-empty-list">尚未配置模型，添加第一个模型后即可用于后续对话。</div> : (
					<div className="settings-model-table" role="table" aria-label="模型列表">
						<div className="settings-model-table-head" role="row"><span>模型</span><span>服务商</span><span>状态</span><span>操作</span></div>
						{profiles.map((profile) => <div className={`settings-model-table-row${editingModelId === profile.id ? ' selected' : ''}`} role="row" key={profile.id}>
							<div><strong>{profile.model}</strong>{profile.isDefault ? <span className="settings-default-tag">当前默认</span> : null}</div>
							<span>{profile.provider === 'openai' ? 'OpenAI Compatible' : profile.provider}</span>
							<span className={profile.enabled ? 'settings-enabled' : 'settings-disabled'}>{profile.enabled ? '已启用' : '已停用'}</span>
							<div className="settings-model-actions">
								<button type="button" onClick={() => handleEdit(profile.id)} disabled={saving}>编辑</button>
								{!profile.isDefault ? <button type="button" onClick={() => onSetDefault(profile.id)} disabled={saving || !profile.enabled}>设为默认</button> : null}
								<button type="button" role="switch" aria-checked={profile.enabled} aria-label={`${profile.model}启用状态`} className={`settings-toggle${profile.enabled ? ' on' : ''}`} onClick={() => onSetEnabled(profile.id, !profile.enabled)} disabled={saving || profile.isDefault}><span /></button>
								{!profile.isDefault ? <button type="button" className="settings-danger-action" onClick={() => onDelete(profile.id)} disabled={saving}>删除</button> : null}
							</div>
						</div>)}
					</div>
				)}
			</section>
			{isFormOpen ? <section className="settings-card settings-form-card" aria-label="模型连接">
				<div className="settings-card-header">
					<div>
						<h2>连接设置</h2>
						<p>连接 OpenAI 兼容的模型服务。</p>
					</div>
					<span className="settings-status-badge">{provider === 'openai' ? 'OpenAI Compatible' : '未选择服务'}</span>
				</div>
				<div className="settings-form-section">
					<div className="settings-form-grid">
						<label className="settings-field">
							<span className="settings-field-label">模型服务</span>
							<select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="模型服务">
								<option value="" disabled>请选择模型服务</option>
								<option value="openai">OpenAI 兼容服务</option>
							</select>
							<span className="settings-field-help">当前支持 OpenAI 兼容协议。</span>
						</label>
						<label className="settings-field">
							<span className="settings-field-label">模型名称</span>
							<input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="如 gpt-4o-mini" aria-label="默认模型" />
							<span className="settings-field-help">{selectedProfile?.isDefault || !model?.models ? '当前用于后续新建会话。' : '保存后可在列表中设为默认模型。'}</span>
						</label>
						<label className="settings-field settings-field-wide">
							<span className="settings-field-label">API 地址</span>
							<input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://api.openai.com/v1" aria-label="API 地址" />
							<span className="settings-field-help">填写服务根地址，无需附加 chat/completions。</span>
						</label>
						<label className="settings-field settings-field-wide">
							<span className="settings-field-label">API Key{apiKeyConfigured ? '（已配置，输入新值可更新）' : '（未配置）'}</span>
							<input
								type="password"
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
								placeholder={apiKeyConfigured ? '密钥已安全保存，输入新值可更新' : '输入 API Key'}
								aria-label="API Key"
							/>
							<span className="settings-field-help">密钥保存在 VS Code SecretStorage，不会回显到页面。</span>
						</label>
					</div>
				</div>
				<div className="settings-card-divider" />
				<div className="settings-card-header settings-card-header-compact">
					<div>
						<h2>生成参数</h2>
						<p>调整回复的随机性、长度和协议运行时。</p>
					</div>
				</div>
				<div className="settings-form-section settings-form-section-compact">
					<div className="settings-form-grid settings-form-grid-three">
						<label className="settings-field">
							<span className="settings-field-label">温度</span>
							<input value={temperature} onChange={(e) => setTemperature(e.target.value)} type="number" step="0.1" min="0" max="2" aria-label="温度" />
							<span className="settings-field-help">0 更稳定，2 更有发散性。</span>
						</label>
						<label className="settings-field">
							<span className="settings-field-label">最大输出 Token</span>
							<input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} type="number" min="1" aria-label="最大输出 token" />
							<span className="settings-field-help">限制单次回复的最大长度。</span>
						</label>
						<label className="settings-field">
							<span className="settings-field-label">最大上下文 Token</span>
							<input value={maxContextTokens} onChange={(e) => setMaxContextTokens(e.target.value)} type="number" min="1024" aria-label="最大上下文 token" />
							<span className="settings-field-help">按模型实际上下文长度填写，默认 262144（256K）。</span>
						</label>
						<label className="settings-field">
							<span className="settings-field-label">模型运行时</span>
							<select value={runtime} onChange={(e) => setRuntime(e.target.value as '' | 'ai-sdk' | 'legacy')} aria-label="模型运行时">
								<option value="" disabled>请选择模型运行时</option>
								<option value="ai-sdk">AI SDK</option>
								<option value="legacy">兼容模式</option>
							</select>
							<span className="settings-field-help">兼容模式仅用于旧服务适配。</span>
						</label>
					</div>
				</div>
				<footer className="settings-card-footer">
					<span className="settings-save-note">{selectedProfile ? '保存后更新该模型配置' : '保存后创建新的模型配置'}</span>
					<button type="button" className="settings-save-btn" onClick={handleSave} disabled={saving || !model}>
						{saving ? '保存中…' : '保存模型配置'}
					</button>
				</footer>
			</section> : null}
		</>
	);
}

/** Skill 分类：展示已加载 Skill 列表、配置来源单选与项目安装表单。 */
function SkillSettings({
	skills,
	source,
	directories,
	installTarget,
	saving,
	onSourceChange,
	onDirectoriesSave,
	onUploadArchive,
}: {
	/** 当前已加载 Skill 列表（加载中为 null） */
	skills: SkillInfo[] | null;
	/** 当前配置来源 */
	source: SyncSource;
	/** 用户配置的 Skill 加载目录 */
	directories: string[];
	/** 安装目标提示（未打开工作区时缺省） */
	installTarget?: string;
	/** 是否安装/切换中 */
	saving: boolean;
	/** 切换配置来源的回调 */
	onSourceChange: (source: SyncSource) => void;
	/** 保存目录并重新加载的回调 */
	onDirectoriesSave: (directories: string[]) => void;
	/** 打开原生文件选择器并上传 ZIP 的回调 */
	onUploadArchive: () => void;
}): JSX.Element {
	const [directoryText, setDirectoryText] = useState('');

	useEffect(() => {
		setDirectoryText(directories.join('\n'));
	}, [directories]);

	const handleDirectoriesSave = (): void => {
		onDirectoriesSave(directoryText.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean));
	};

	return (
		<>
			<div className="settings-heading">
				<span className="settings-eyebrow">能力中心</span>
				<h1>Skill</h1>
				<p>查看已加载的工作流与专业能力，或将新 Skill 安装到项目。</p>
			</div>
			<section className="settings-card settings-form-card" aria-label="配置来源">
				<div className="settings-card-header">
					<div>
						<h2>加载设置</h2>
						<p>选择生态来源并维护工作区内的 Skill 扫描目录。</p>
					</div>
				</div>
				<div className="settings-form-section">
					<div className="settings-source-field">
						<span className="settings-field-label">生态配置来源</span>
						<div className="settings-radio-group" role="radiogroup" aria-label="配置来源">
							{SOURCE_OPTIONS.map((opt) => (
								<label key={opt.value} className="settings-radio">
									<input
										type="radio"
										name="syncSource"
										value={opt.value}
										checked={source === opt.value}
										disabled={saving}
										onChange={() => onSourceChange(opt.value)}
									/>
									<span>{opt.label}</span>
								</label>
							))}
						</div>
						<span className="settings-field-help">来源之间互斥，切换后会立即重新加载。Agent 来源加载全局 ~/.agents/skills 目录；Skill 列表中会显示其来源路径。</span>
					</div>
					<label className="settings-field">
						<span className="settings-field-label">Skill 加载目录</span>
						<textarea
							value={directoryText}
							onChange={(e) => setDirectoryText(e.target.value)}
							rows={3}
							placeholder="每行一个相对工作区根目录，如 .vscode/skills"
							aria-label="Skill 加载目录"
						/>
						<span className="settings-field-help">每行一个相对工作区根目录；绝对路径和越级路径会被忽略。</span>
					</label>
				</div>
				<footer className="settings-card-footer settings-card-footer-end">
					<button type="button" className="settings-save-btn" onClick={handleDirectoriesSave} disabled={saving}>
						{saving ? '重新加载中…' : '保存并重新加载 Skill'}
					</button>
				</footer>
			</section>
			<section className="settings-card settings-form-card" aria-label="上传 Skill ZIP">
				<div className="settings-card-header">
					<div>
						<h2>上传项目 Skill</h2>
						<p>选择 ZIP 文件后自动解析，并仅安装符合 Skill 协议的内容。</p>
					</div>
				</div>
				<div className="settings-form-section">
					{installTarget ? (
						<p className="settings-target-path">目标路径 <code>{installTarget}</code></p>
					) : (
						<p className="settings-note settings-note-error">未打开工作区，无法安装项目 Skill。</p>
					)}
					<button type="button" className="settings-skill-upload" onClick={onUploadArchive} disabled={saving || !installTarget}>
						<span className="settings-skill-upload-icon" aria-hidden="true">↑</span>
						<span><strong>{saving ? '正在解析并安装…' : '选择 Skill ZIP 文件'}</strong><small>支持 .zip，包内须有唯一的 SKILL.md</small></span>
					</button>
					<div className="settings-upload-requirements" aria-label="Skill ZIP 校验规则">
						<span>必需：<code>SKILL.md</code></span><span>Frontmatter：<code>name</code>、<code>description</code></span><span>自动保留资源文件</span>
					</div>
				</div>
			</section>
			<section className="settings-card" aria-label="已加载 Skill">
				<div className="settings-card-header settings-card-header-list">
					<div>
						<h2>已加载 Skill</h2>
						<p>当前可被 Agent 调用的专业能力。</p>
					</div>
					{skills ? <span className="settings-count-badge">{skills.length}</span> : null}
				</div>
				{skills === null ? (
					<p className="settings-note">正在加载…</p>
				) : skills.length === 0 ? (
					<div className="settings-empty-card">
						<strong>暂无已加载 Skill</strong>
						<span>可切换配置来源或安装项目 Skill。</span>
					</div>
				) : (
					<ul className="settings-skill-list">
						{skills.map((skill) => (
							<li key={skill.name} className="settings-row">
								<div><strong>{skill.name}</strong><span>{skill.description}</span></div>
								{skill.sourcePath ? <span className="settings-value">{skill.sourcePath}</span> : null}
							</li>
						))}
					</ul>
				)}
			</section>
		</>
	);
}

/** 使用情况分类静态内容（明确不代表真实统计）。 */
function UsageSettings(): JSX.Element {
	return (
		<>
			<div className="settings-heading">
				<span className="settings-eyebrow">透明度</span>
				<h1>使用情况</h1>
				<p>用量统计会在接入真实数据后显示在这里。</p>
			</div>
			<section className="settings-card settings-empty-card" aria-label="使用情况">
				<div className="settings-empty-icon"><SettingsSectionIcon section="usage" /></div>
				<strong>使用情况数据将在后续版本接入</strong>
				<span>本页不会读取或展示真实 token、费用或账户统计。</span>
			</section>
		</>
	);
}

/** MCP 设置页反馈（含可选字段路径，与模型/Skill 反馈隔离，推送不清空其他草稿）。 */
type McpFeedback = { readonly kind: 'success' | 'error'; readonly message: string; readonly fieldPath?: string } | null;

/** MCP 成功反馈的可见时长（毫秒）。 */
const MCP_SUCCESS_FEEDBACK_DURATION_MS = 3_000;

/** 新增 JSON 模板（含 STDIO 与 Streamable HTTP 两类示例，用户按需修改）。 */
const MCP_TEMPLATE = `{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "your-command",
      "args": [],
      "env": {},
      "enabled": true
    }
  }
}`;

/** Transport 中文标签（配置/实际均使用，legacy-sse 仅作为实际 Transport 出现）。 */
function transportLabel(t: 'stdio' | 'streamable-http' | 'legacy-sse'): string {
	if (t === 'stdio') { return 'STDIO'; }
	if (t === 'streamable-http') { return 'Streamable HTTP'; }
	return 'Legacy SSE';
}

/** MCP Server 状态中文标签（不只依赖颜色，便于无障碍识别）。 */
function mcpStatusLabel(status: McpServerStatus): string {
	switch (status) {
		case 'disabled': return '已停用';
		case 'waiting_workspace_trust': return '等待信任工作区';
		case 'connecting': return '连接中';
		case 'ready': return '就绪';
		case 'reconnecting': return '重连中';
		case 'error': return '错误';
		case 'stopping': return '停止中';
	}
}

/** 由非敏感 Server 视图构建编辑预填 JSON（env/header 值替换为秘密占位）。 */
function buildEditJson(server: McpServerView): string {
	const cfg = server.config;
	if (cfg.type === 'stdio') {
		const env: Record<string, string> = {};
		for (const k of cfg.envKeys) { env[k] = MCP_SECRET_PLACEHOLDER; }
		const entry: Record<string, unknown> = {
			type: 'stdio',
			command: cfg.command,
			args: cfg.args,
			env,
			enabled: cfg.enabled,
			connectTimeoutMs: cfg.connectTimeoutMs,
			callTimeoutMs: cfg.callTimeoutMs,
		};
		if (cfg.cwd !== undefined) { entry.cwd = cfg.cwd; }
		return JSON.stringify({ mcpServers: { [server.id]: entry } }, null, 2);
	}
	const headers: Record<string, string> = {};
	for (const n of cfg.headerNames) { headers[n] = MCP_SECRET_PLACEHOLDER; }
	const entry = {
		type: 'streamable-http',
		url: cfg.url,
		headers,
		legacySseFallback: cfg.legacySseFallback,
		enabled: cfg.enabled,
		connectTimeoutMs: cfg.connectTimeoutMs,
		callTimeoutMs: cfg.callTimeoutMs,
	};
	return JSON.stringify({ mcpServers: { [server.id]: entry } }, null, 2);
}

/**
 * MCP 分类：JSON 新增/批量导入与编辑、Server 列表、启停/重连/删除。
 * 秘密明文永不出现在页面或反馈中：编辑预填使用占位值，列表只展示 envKeys/headerNames。
 *
 * @param servers 宿主返回的非敏感 Server 快照（加载中为 null）
 * @param saving JSON 保存中（仅禁用保存按钮，不阻塞其他操作）
 * @param feedback 操作反馈（含可选 fieldPath）
 * @param onSaveJson 提交 JSON 保存（mode/editingServerId）
 * @param onSetEnabled 切换 Server 启用状态
 * @param onReconnect 请求重连 Server
 * @param onDelete 请求删除 Server
 * @returns MCP 分类 JSX
 */
function McpSettings({
	servers,
	saving,
	feedback,
	onSaveJson,
	onSetEnabled,
	onReconnect,
	onDelete,
}: {
	servers: readonly McpServerView[] | null;
	saving: boolean;
	feedback: McpFeedback;
	onSaveJson: (json: string, mode: McpSaveMode, editingServerId?: string) => void;
	onSetEnabled: (serverId: string, enabled: boolean) => void;
	onReconnect: (serverId: string) => void;
	onDelete: (serverId: string) => void;
}): JSX.Element {
	const [editorOpen, setEditorOpen] = useState(false);
	const [mode, setMode] = useState<McpSaveMode>('add');
	const [editingServerId, setEditingServerId] = useState<string | undefined>(undefined);
	const [jsonText, setJsonText] = useState('');
	const [expandedId, setExpandedId] = useState<string | undefined>(undefined);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | undefined>(undefined);
	const [searchText, setSearchText] = useState('');
	const [setupTab, setSetupTab] = useState<'quick' | 'manual' | 'json'>('quick');
	const visibleServers = useMemo(() => {
		const keyword = searchText.trim().toLocaleLowerCase();
		if (!keyword || !servers) {
			return servers ?? [];
		}
		return servers.filter((server) => [server.id, server.configuredTransport, server.actualTransport ?? '']
			.join(' ').toLocaleLowerCase().includes(keyword));
	}, [searchText, servers]);
	const readyServerCount = servers?.filter((server) => server.status === 'ready').length ?? 0;
	const totalToolCount = servers?.reduce((total, server) => total + server.toolCount, 0) ?? 0;

	/** 打开新增/批量导入 JSON 编辑器并预填模板。 */
	const handleOpenAdd = (): void => {
		setMode('add');
		setEditingServerId(undefined);
		setEditorOpen(true);
		setSetupTab('quick');
		setJsonText(MCP_TEMPLATE);
	};

	/** 打开编辑 JSON 编辑器，由 Server 视图预填（env/header 为占位）。 @param server 待编辑 Server。 */
	const handleOpenEdit = (server: McpServerView): void => {
		setMode('edit');
		setEditingServerId(server.id);
		setEditorOpen(true);
		setSetupTab('json');
		setJsonText(buildEditJson(server));
	};

	/** 关闭编辑器并清空明文输入引用。 */
	const handleClose = (): void => {
		setEditorOpen(false);
		setJsonText('');
		setEditingServerId(undefined);
	};

	/** 提交保存并把明文输入交给宿主。 */
	const handleSave = (): void => {
		onSaveJson(jsonText, mode, editingServerId);
	};

	/** 请求宿主刷新 MCP Server 状态快照。 @returns 无返回值。 */
	const handleRefresh = (): void => {
		post({ command: 'requestMcpSettings' });
	};

	// 客户端语法预检（即时反馈；宿主仍会重新校验并返回精确 fieldPath）
	let clientSyntaxError: string | undefined;
	if (editorOpen && jsonText.trim()) {
		try {
			JSON.parse(jsonText);
		} catch (e) {
			clientSyntaxError = `JSON 语法错误：${e instanceof Error ? e.message : String(e)}`;
		}
	}
	const showError = feedback?.kind === 'error' ? feedback : null;
	const showFieldPath = showError?.fieldPath ?? undefined;
	const canSave = !saving && !clientSyntaxError;

	if (editorOpen) {
		return (
			<section className="mcp-config-page" aria-label="MCP JSON 编辑">
				<button type="button" className="mcp-back-button" onClick={handleClose}>← 返回 MCP 列表</button>
				<header className="mcp-config-heading">
					<h1>{mode === 'add' ? '添加 MCP 服务器' : `编辑 MCP 服务器：${editingServerId}`}</h1>
					<p>统一通过 JSON 配置保存 Server；密钥字段仅会以安全占位形式回显。</p>
				</header>
				<section className="mcp-editor-card">
					<div className="mcp-setup-tabs" role="tablist" aria-label="配置方式">
						{(['quick', 'manual', 'json'] as const).map((tab) => (
							<button key={tab} type="button" role="tab" aria-selected={setupTab === tab} className={setupTab === tab ? 'active' : ''} onClick={() => setSetupTab(tab)}>
								{tab === 'quick' ? '快速安装' : tab === 'manual' ? '手动配置' : 'JSON'}
							</button>
						))}
					</div>
					<h2 className="mcp-editor-title">{mode === 'add' ? '新增 / 批量导入' : `编辑：${editingServerId}`}</h2>
					<label className="mcp-config-field">
						<span>命令、URL 或 JSON</span>
						<textarea
							className="mcp-json-textarea"
							aria-label="MCP JSON 配置"
							spellCheck={false}
							value={jsonText}
							onChange={(e) => setJsonText(e.target.value)}
						/>
					</label>
					<p className="mcp-config-help">请粘贴符合 <code>mcpServers</code> 结构的 JSON；可一次添加多个 Server。</p>
					<div className="mcp-config-benefits" aria-label="配置说明">
						<span>自动校验传输方式</span><span>保存后验证连接</span><span>所有工具直接可用</span>
					</div>
					{clientSyntaxError ? <div className="settings-feedback settings-feedback-error" role="alert">{clientSyntaxError}</div> : null}
					<footer className="mcp-editor-footer">
						<button type="button" className="settings-secondary-button" onClick={handleClose}>取消</button>
						<button type="button" className="settings-primary-button" onClick={handleSave} disabled={!canSave} aria-label="保存 MCP 配置">
							{saving ? '保存中…' : mode === 'add' ? '添加并连接' : '保存更改'}
						</button>
					</footer>
				</section>
				{feedback ? <div className={`settings-feedback${feedback.kind === 'error' ? ' settings-feedback-error' : ''}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}{showFieldPath ? <span className="mcp-field-path">字段：{showFieldPath}</span> : null}</div> : null}
			</section>
		);
	}

	return (
		<section className="mcp-management-page">
			<header className="mcp-management-header">
				<div>
					<h2 className="mcp-page-title" aria-label="MCP">MCP 与工具</h2>
					<p>管理 MCP 服务连接和工具发现。配置由插件私有存储管理，不自动读取项目 .mcp.json 文件。</p>
				</div>
				<div className="mcp-header-actions">
					<button type="button" className="mcp-icon-button" onClick={handleRefresh} aria-label="刷新 MCP 服务">↻</button>
					<button type="button" className="settings-primary-button mcp-add-button" onClick={handleOpenAdd} aria-label="添加/导入 JSON">+ 添加服务器</button>
				</div>
			</header>
			<div className="mcp-overview" aria-label="MCP 概览">
				<span>{readyServerCount} 个服务已连接</span><span>· {servers?.length ?? 0} 个服务</span><span>· {totalToolCount} 个工具</span>
			</div>
			<label className="mcp-search-field">
				<span aria-hidden="true">⌕</span>
				<input type="search" role="searchbox" aria-label="搜索 MCP 服务" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索 MCP 服务…" />
			</label>
			{feedback ? <div className={`settings-feedback${feedback.kind === 'error' ? ' settings-feedback-error' : ''}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}{showFieldPath ? <span className="mcp-field-path">字段：{showFieldPath}</span> : null}</div> : null}
			<section className="mcp-server-section" aria-label="MCP Server 列表">
				<header><h3>当前项目 <span>{visibleServers.length}</span></h3><p>由当前项目声明，默认自动可用。</p></header>
				{!servers ? <div className="settings-empty-list">正在加载 MCP Server…</div> : visibleServers.length === 0 ? (
					<div className="mcp-empty-state">
						<div className="mcp-empty-state-icon" aria-hidden="true">⌘</div>
						<strong>{searchText ? '未找到匹配的 MCP Server' : '暂无 MCP Server'}</strong>
						<p>{searchText ? '请调整搜索关键词，或清空搜索后查看全部服务。' : '添加第一个服务后，可在此查看连接状态与已发现工具。'}</p>
						{searchText ? null : <button type="button" className="mcp-empty-state-action" onClick={handleOpenAdd} aria-label="添加服务器（空状态）">+ 添加服务器</button>}
					</div>
				) : (
					<div className="mcp-server-list">
						{visibleServers.map((server) => (
							<article className="mcp-server-item" key={server.id} data-server-id={server.id}>
								<div className="mcp-server-icon" aria-hidden="true">▤</div>
								<div className="mcp-server-body">
									<div className="mcp-server-row">
										<button type="button" className="mcp-server-name" onClick={() => setExpandedId(expandedId === server.id ? undefined : server.id)} aria-expanded={expandedId === server.id} aria-label={`展开 ${server.id} 详情`}>
											<span className={`mcp-status-dot mcp-status-${server.status}`} />{server.id}
										</button>
										<span className="mcp-server-transport">{transportLabel(server.configuredTransport)}</span>
										<span className={`mcp-server-status mcp-status-${server.status}`}>{mcpStatusLabel(server.status)}</span>
										<span className="mcp-server-tools">工具 {server.toolCount}</span>
									</div>
									<p className="mcp-server-summary">{server.status === 'ready' ? '可用 · 已发现工具' : mcpStatusLabel(server.status)} · 配置：{transportLabel(server.configuredTransport)}{server.actualTransport && server.actualTransport !== server.configuredTransport ? ` · 实际：${transportLabel(server.actualTransport)}` : ''}</p>
									<p className="mcp-server-command">{server.config.type === 'stdio' ? [server.config.command, ...server.config.args].join(' ') : server.config.url}</p>
									{server.errorSummary ? <p className="mcp-server-error" role="alert">{server.errorSummary}</p> : null}
									{expandedId === server.id && server.status === 'ready' && server.tools.length > 0 ? <ul className="mcp-tool-list" aria-label={`${server.id} 已发现工具`}>{server.tools.map((tool) => <li key={tool.name} className="mcp-tool-item"><strong>{tool.name}</strong>{tool.description ? <span> — {tool.description}</span> : null}</li>)}</ul> : null}
								</div>
								<div className="mcp-server-actions">
									<button type="button" className="mcp-action-button" onClick={() => onReconnect(server.id)} aria-label={`重连 ${server.id}`}>↻</button>
									<button type="button" className="mcp-action-button" onClick={() => handleOpenEdit(server)} aria-label={`编辑 ${server.id}`}>编辑</button>
									{confirmDeleteId === server.id ? <span className="mcp-confirm-delete"><span>确认删除？</span><button type="button" className="settings-danger-button" onClick={() => { onDelete(server.id); setConfirmDeleteId(undefined); }} aria-label={`确认删除 ${server.id}`}>确认</button><button type="button" className="settings-secondary-button" onClick={() => setConfirmDeleteId(undefined)} aria-label={`取消删除 ${server.id}`}>取消</button></span> : <button type="button" className="mcp-delete-button" onClick={() => setConfirmDeleteId(server.id)} aria-label={`删除 ${server.id}`}>删除</button>}
									<button type="button" aria-pressed={server.enabled} className={`mcp-toggle${server.enabled ? ' on' : ''}`} onClick={() => onSetEnabled(server.id, !server.enabled)} aria-label={server.enabled ? `停用 ${server.id}` : `启用 ${server.id}`}><span /></button>
								</div>
							</article>
						))}
					</div>
				)}
			</section>
		</section>
	);
}

/** 根据当前分类渲染右侧内容。 */
function SettingsContent({
	section,
	model,
	skills,
	source,
	directories,
	installTarget,
	saving,
	mcpServers,
	mcpSaving,
	mcpFeedback,
	onSaveModel,
	onSetDefaultModel,
	onSetModelEnabled,
	onDeleteModel,
	onSourceChange,
	onDirectoriesSave,
	onUploadArchive,
	onSaveMcpJson,
	onSetMcpEnabled,
	onReconnectMcp,
	onDeleteMcp,
}: {
	section: SettingsSection;
	model: ModelSettingsView | null;
	skills: SkillInfo[] | null;
	source: SyncSource;
	directories: string[];
	installTarget?: string;
	saving: boolean;
	mcpServers: readonly McpServerView[] | null;
	mcpSaving: boolean;
	mcpFeedback: McpFeedback;
	onSaveModel: (input: ModelSettingsInput) => void;
	/** 设置默认模型回调。 */
	onSetDefaultModel: (modelId: string) => void;
	/** 更新模型启用状态回调。 */
	onSetModelEnabled: (modelId: string, enabled: boolean) => void;
	/** 删除模型回调。 */
	onDeleteModel: (modelId: string) => void;
	onSourceChange: (source: SyncSource) => void;
	onDirectoriesSave: (directories: string[]) => void;
	onUploadArchive: () => void;
	onSaveMcpJson: (json: string, mode: McpSaveMode, editingServerId?: string) => void;
	/** 切换 MCP Server 启用状态回调。 */
	onSetMcpEnabled: (serverId: string, enabled: boolean) => void;
	/** 重连 MCP Server 回调。 */
	onReconnectMcp: (serverId: string) => void;
	/** 删除 MCP Server 回调。 */
	onDeleteMcp: (serverId: string) => void;
}): JSX.Element {
	if (section === 'skill') {
		return (
			<SkillSettings
				skills={skills}
				source={source}
				directories={directories}
				installTarget={installTarget}
				saving={saving}
				onSourceChange={onSourceChange}
				onDirectoriesSave={onDirectoriesSave}
				onUploadArchive={onUploadArchive}
			/>
		);
	}
	if (section === 'mcp') {
		return (
			<McpSettings
				servers={mcpServers}
				saving={mcpSaving}
				feedback={mcpFeedback}
				onSaveJson={onSaveMcpJson}
				onSetEnabled={onSetMcpEnabled}
				onReconnect={onReconnectMcp}
				onDelete={onDeleteMcp}
			/>
		);
	}
	if (section === 'usage') {
		return <UsageSettings />;
	}
	return <ModelSettings model={model} saving={saving} onSave={onSaveModel} onSetDefault={onSetDefaultModel} onSetEnabled={onSetModelEnabled} onDelete={onDeleteModel} />;
}

/** 设置页：分类导航 + 模型/Skill 受控交互 + 使用情况占位。 */
export function SettingsPage(): JSX.Element {
	const [activeSection, setActiveSection] = useState<SettingsSection>('model');
	const [model, setModel] = useState<ModelSettingsView | null>(null);
	const [skills, setSkills] = useState<SkillInfo[] | null>(null);
	const [source, setSource] = useState<SyncSource>('claude');
	const [directories, setDirectories] = useState<string[]>([]);
	const [installTarget, setInstallTarget] = useState<string | undefined>(undefined);
	const [saving, setSaving] = useState(false);
	const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
	// MCP 状态与模型/Skill 隔离：Host 推送 MCP 快照时不清空模型/Skill 草稿
	const [mcpServers, setMcpServers] = useState<readonly McpServerView[] | null>(null);
	const [mcpSaving, setMcpSaving] = useState(false);
	const [mcpFeedback, setMcpFeedback] = useState<McpFeedback>(null);
	// 当前待确认的异步动作：install=安装后等待新快照，source=来源切换后等待新快照（用 ref 供订阅闭包读取最新值）
	const pendingActionRef = useRef<'archive' | 'source' | 'directories' | 'modelAction' | null>(null);

	// 成功反馈只作短暂提示；错误反馈保留，确保用户有时间查看并处理。
	useEffect(() => {
		if (mcpFeedback?.kind !== 'success') {
			return;
		}
		const timer = window.setTimeout(() => {
			setMcpFeedback((current) => current?.kind === 'success' ? null : current);
		}, MCP_SUCCESS_FEEDBACK_DURATION_MS);
		return () => window.clearTimeout(timer);
	}, [mcpFeedback]);

	// 挂载时请求初始数据并订阅宿主响应
	useEffect(() => {
		post({ command: 'requestModelSettings' });
		post({ command: 'requestSkills' });
		post({ command: 'requestMcpSettings' });
		return subscribe((msg: HostToWebviewMessage) => {
			switch (msg.command) {
				case 'modelSettings':
					setModel(msg.model);
					setFeedback(null);
					break;
				case 'modelSettingsSaved':
					setModel(msg.model);
					setSaving(false);
					setFeedback({ kind: 'success', message: pendingActionRef.current === 'modelAction' ? '模型列表已更新' : '模型配置已保存，后续新会话生效' });
					pendingActionRef.current = null;
					break;
				case 'skillsList':
					setSkills(msg.skills);
					setSource(msg.source);
					setDirectories(msg.directories);
					setInstallTarget(msg.installTarget);
					setSaving(false);
					if (pendingActionRef.current === 'archive') {
						setFeedback({ kind: 'success', message: 'Skill ZIP 已校验并安装，列表已刷新' });
					} else if (pendingActionRef.current === 'source') {
						setFeedback({ kind: 'success', message: '配置来源已切换' });
					} else if (pendingActionRef.current === 'directories') {
						setFeedback({ kind: 'success', message: 'Skill 目录已保存并重新加载' });
					}
					pendingActionRef.current = null;
					break;
				case 'settingsError':
					setSaving(false);
					pendingActionRef.current = null;
					setFeedback({ kind: 'error', message: msg.message });
					break;
				case 'mcpSettings':
					// 状态推送只更新 MCP 快照，不影响模型/Skill 草稿
					setMcpServers(msg.servers);
					break;
				case 'mcpSettingsSaved':
					setMcpServers(msg.servers);
					setMcpSaving(false);
					setMcpFeedback({ kind: 'success', message: 'MCP 配置已保存，连接将在后台建立' });
					break;
				case 'mcpOperationAccepted':
					setMcpSaving(false);
					setMcpFeedback({ kind: 'success', message: `操作已接受：${msg.operation}（${msg.serverId}），最终状态以后续快照为准` });
					break;
				case 'mcpSettingsError':
					setMcpSaving(false);
					setMcpFeedback({ kind: 'error', message: msg.message, ...(msg.fieldPath ? { fieldPath: msg.fieldPath } : {}) });
					break;
			}
		});
	}, []);

	const handleSaveModel = (input: ModelSettingsInput): void => {
		setFeedback(null);
		setSaving(true);
		post({ command: 'saveModelSettings', model: input });
	};

	/** 设置默认模型。 */
	const handleSetDefaultModel = (modelId: string): void => {
		setFeedback(null);
		setSaving(true);
		pendingActionRef.current = 'modelAction';
		post({ command: 'setDefaultModel', modelId });
	};

	/** 更新模型启用状态。 */
	const handleSetModelEnabled = (modelId: string, enabled: boolean): void => {
		setFeedback(null);
		setSaving(true);
		pendingActionRef.current = 'modelAction';
		post({ command: 'setModelEnabled', modelId, enabled });
	};

	/** 删除模型。 */
	const handleDeleteModel = (modelId: string): void => {
		setFeedback(null);
		setSaving(true);
		pendingActionRef.current = 'modelAction';
		post({ command: 'deleteModel', modelId });
	};

	const handleSourceChange = (next: SyncSource): void => {
		if (next === source) {
			return;
		}
		setFeedback(null);
		setSaving(true);
		pendingActionRef.current = 'source';
		post({ command: 'setSyncSource', source: next });
	};

	const handleDirectoriesSave = (next: string[]): void => {
		setFeedback(null);
		setSaving(true);
		pendingActionRef.current = 'directories';
		post({ command: 'setSkillDirectories', directories: next });
	};

	/** 请求宿主选择 ZIP 文件并自动解析安装。 */
	const handleUploadArchive = (): void => {
		setFeedback(null);
		setSaving(true);
		pendingActionRef.current = 'archive';
		post({ command: 'uploadSkillArchive' });
	};

	/** 提交 MCP JSON 保存（add 新增/批量导入，edit 编辑单个 Server）。 */
	const handleSaveMcpJson = (json: string, mode: McpSaveMode, editingServerId?: string): void => {
		setMcpFeedback(null);
		setMcpSaving(true);
		post({ command: 'saveMcpServersJson', json, mode, editingServerId });
	};

	/** 切换 MCP Server 启用状态。 */
	const handleSetMcpEnabled = (serverId: string, enabled: boolean): void => {
		setMcpFeedback(null);
		setMcpSaving(true);
		post({ command: 'setMcpServerEnabled', serverId, enabled });
	};

	/** 请求重连指定 MCP Server（不改配置，仅重建 Connection）。 */
	const handleReconnectMcp = (serverId: string): void => {
		setMcpFeedback(null);
		setMcpSaving(true);
		post({ command: 'reconnectMcpServer', serverId });
	};

	/** 请求删除指定 MCP Server（含其全部 Secrets）。 */
	const handleDeleteMcp = (serverId: string): void => {
		setMcpFeedback(null);
		setMcpSaving(true);
		post({ command: 'deleteMcpServer', serverId });
	};

	return (
		<section className="settings-page" aria-label="设置">
			<aside className="settings-nav" aria-label="设置分类">
				<div className="settings-nav-title">设置</div>
				<nav>
					{SETTINGS_NAV_ITEMS.map((item) => (
						<button
							key={item.id}
							type="button"
							className={`settings-nav-item${activeSection === item.id ? ' active' : ''}`}
							aria-label={item.label}
							aria-current={activeSection === item.id ? 'page' : undefined}
							onClick={() => setActiveSection(item.id)}
						>
							<SettingsSectionIcon section={item.id} />
							<span>{item.label}</span>
						</button>
					))}
				</nav>
			</aside>
			<main className="settings-content">
				<div className="settings-content-inner">
					{feedback ? (
						<div className={`settings-feedback ${feedback.kind === 'error' ? 'settings-feedback-error' : ''}`} role="status">
							{feedback.message}
						</div>
					) : null}
					<SettingsContent
						section={activeSection}
						model={model}
						skills={skills}
						source={source}
						directories={directories}
						installTarget={installTarget}
						saving={saving}
						mcpServers={mcpServers}
						mcpSaving={mcpSaving}
						mcpFeedback={mcpFeedback}
						onSaveModel={handleSaveModel}
						onSetDefaultModel={handleSetDefaultModel}
						onSetModelEnabled={handleSetModelEnabled}
						onDeleteModel={handleDeleteModel}
						onSourceChange={handleSourceChange}
						onDirectoriesSave={handleDirectoriesSave}
						onUploadArchive={handleUploadArchive}
						onSaveMcpJson={handleSaveMcpJson}
						onSetMcpEnabled={handleSetMcpEnabled}
						onReconnectMcp={handleReconnectMcp}
						onDeleteMcp={handleDeleteMcp}
					/>
				</div>
			</main>
		</section>
	);
}
