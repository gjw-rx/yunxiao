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
	CommandInfo,
	CommandInput,
	CommandScope,
	HostToWebviewMessage,
	ModelSettingsInput,
	ModelSettingsView,
	McpServerView,
	McpServerStatus,
	McpSaveMode,
	SkillInfo,
	SyncSource,
	HooksConfigView,
	RtkStatusView,
	UsageGranularity,
	TokenUsageStatsResult,
} from '../../protocol';
import { MCP_SECRET_PLACEHOLDER } from '../../protocol';
import { formatNumber } from '../../utils/format';

/** 设置分类标识。 */
type SettingsSection = 'model' | 'skill' | 'command' | 'mcp' | 'hooks' | 'usage';

/** 设置分类导航项。 */
interface SettingsNavItem {
	/** 分类标识。 */
	readonly id: SettingsSection;
	/** 显示名称。 */
	readonly label: string;
}

/** 设置页分类列表（顺序：模型、Skill、命令、MCP、Hooks、使用情况）。 */
const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
	{ id: 'model', label: '模型' },
	{ id: 'skill', label: 'Skill' },
	{ id: 'command', label: '命令' },
	{ id: 'mcp', label: 'MCP' },
	{ id: 'hooks', label: 'Hooks' },
	{ id: 'usage', label: '使用情况' },
];

/** 配置来源选项（四值互斥，默认 claude）。 */
const SOURCE_OPTIONS: readonly { value: SyncSource; label: string }[] = [
	{ value: 'claude', label: 'Claude' },
	{ value: 'trae', label: 'Trae' },
	{ value: 'agent', label: 'Agent' },
	{ value: 'none', label: '不加载' },
];

/** 将 Date 格式化为本地 YYYY-MM-DD。 @param d 日期。 @returns 本地日期字符串。 */
function toLocalISODate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

/** 返回今天的本地 YYYY-MM-DD。 @returns 今天日期字符串。 */
function todayLocalISO(): string {
	return toLocalISODate(new Date());
}

/** 设置分类图标。 */
function SettingsSectionIcon({ section }: { section: SettingsSection }): JSX.Element {
	if (section === 'model') {
		return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35"><path d="M3 4.5h10M3 8h10M3 11.5h10M5 3v3M11 6.5v3M7 10v3" /></svg>;
	}
	if (section === 'skill') {
		return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35"><path d="M8 1.7 9.4 5l3.4 1.4-3.4 1.4L8 11.1 6.6 7.8 3.2 6.4 6.6 5 8 1.7Z" /><path d="m12.1 10.2.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7.7-1.7Z" /></svg>;
	}
	if (section === 'command') {
		return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35"><path d="M3.5 5.5 6 8 3.5 10.5M9 12h3.5" /><path d="M8 2v12" /></svg>;
	}
	if (section === 'mcp') {
		return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35"><path d="M2 4.5 8 2l6 2.5v7L8 14 2 11.5z" /><path d="M2 4.5 8 7l6-2.5M8 7v7" /></svg>;
	}
	if (section === 'hooks') {
		return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35"><path d="M8 2v5m0 0a3 3 0 0 1 3 3v1a3 3 0 0 1-6 0v-1a3 3 0 0 1 3-3Z" /><path d="M5.5 12.5h5" /></svg>;
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

	/** 切换模型服务：新建模型时若目标服务有专属默认地址且当前地址为空或仍是另一服务的默认地址，则自动填充。 @param nextProvider 目标 Provider ID。 @returns 无返回值。 */
	const handleProviderChange = (nextProvider: string): void => {
		setProvider(nextProvider);
		if (nextProvider === 'anthropic') {
			if (!baseURL || baseURL === 'https://api.openai.com/v1') {
				setBaseURL('https://api.anthropic.com/v1');
			}
			// Anthropic 不支持 legacy 运行时，切换服务时一并纠正
			if (runtime === 'legacy') {
				setRuntime('ai-sdk');
			}
		} else if (nextProvider === 'openai' && baseURL === 'https://api.anthropic.com/v1') {
			setBaseURL('https://api.openai.com/v1');
		}
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
							<span>{profile.provider === 'openai' ? 'OpenAI Compatible' : profile.provider === 'anthropic' ? 'Anthropic Messages' : profile.provider}</span>
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
						<p>连接 OpenAI 兼容或 Anthropic 原生 Messages 模型服务。</p>
					</div>
					<span className="settings-status-badge">{provider === 'openai' ? 'OpenAI Compatible' : provider === 'anthropic' ? 'Anthropic Messages' : '未选择服务'}</span>
				</div>
				<div className="settings-form-section">
					<div className="settings-form-grid">
						<label className="settings-field">
							<span className="settings-field-label">模型服务</span>
							<select value={provider} onChange={(e) => handleProviderChange(e.target.value)} aria-label="模型服务">
								<option value="" disabled>请选择模型服务</option>
								<option value="openai">OpenAI 兼容服务</option>
								<option value="anthropic">Anthropic（Claude 原生 Messages API）</option>
							</select>
							<span className="settings-field-help">{provider === 'anthropic' ? '通过 Anthropic 官方 Messages API 调用 Claude。' : '当前支持 OpenAI 兼容协议。'}</span>
						</label>
						<label className="settings-field">
							<span className="settings-field-label">模型名称</span>
							<input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder={provider === 'anthropic' ? '如 claude-3-5-sonnet-latest' : '如 gpt-4o-mini'} aria-label="默认模型" />
							<span className="settings-field-help">{selectedProfile?.isDefault || !model?.models ? '当前用于后续新建会话。' : '保存后可在列表中设为默认模型。'}</span>
						</label>
						<label className="settings-field settings-field-wide">
							<span className="settings-field-label">API 地址</span>
							<input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder={provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'} aria-label="API 地址" />
							<span className="settings-field-help">{provider === 'anthropic' ? '留空则使用 Anthropic 官方地址，也可填写兼容代理地址。' : '填写服务根地址，无需附加 chat/completions。'}</span>
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
								<option value="legacy" disabled={provider === 'anthropic'}>兼容模式</option>
							</select>
							<span className="settings-field-help">{provider === 'anthropic' ? 'Anthropic 仅支持 AI SDK 运行时。' : '兼容模式仅用于旧服务适配。'}</span>
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

/** Command 设置页反馈（与模型/Skill 反馈隔离，推送不清空其他草稿）。 */
type CommandFeedback = { kind: 'success' | 'error'; message: string } | null;

/** Command 设置页双作用域快照（null=加载中）。 */
interface CommandSnapshotView {
	/** 全局作用域命令列表（含被项目覆盖的项）。 */
	readonly global: readonly CommandInfo[];
	/** 项目作用域命令列表。 */
	readonly project: readonly CommandInfo[];
	/** 全局命令目录绝对路径。 */
	readonly globalDirectory?: string;
	/** 项目命令目录绝对路径（未打开工作区时缺省）。 */
	readonly projectDirectory?: string;
	/** 项目作用域是否可用（未打开工作区时为 false，写操作禁用）。 */
	readonly projectAvailable: boolean;
}

/**
 * Command 分类：全局/项目作用域切换、实际目录、命令列表、刷新、创建/编辑/删除。
 * 复用现有设置页 token 与卡片结构；正文仅作为模板输入，不在列表中回显全文。
 *
 * @param snapshot 宿主返回的双作用域快照（null=加载中）
 * @param saving 是否正在写操作（保存/删除）
 * @param feedback 操作反馈
 * @param savedTick 写操作成功后递增的计数（用于关闭表单/删除确认）
 * @param projectAvailable 项目作用域是否可用
 * @param onRefresh 手动刷新命令
 * @param onCreate 创建 Command
 * @param onUpdate 编辑 Command
 * @param onDelete 删除 Command
 * @returns Command 分类 JSX
 */
function CommandSettings({
	snapshot,
	saving,
	feedback,
	savedTick,
	onRefresh,
	onCreate,
	onUpdate,
	onDelete,
}: {
	snapshot: CommandSnapshotView | null;
	saving: boolean;
	feedback: CommandFeedback;
	savedTick: number;
	onRefresh: () => void;
	onCreate: (scope: CommandScope, input: CommandInput) => void;
	onUpdate: (scope: CommandScope, name: string, input: CommandInput) => void;
	onDelete: (scope: CommandScope, name: string) => void;
}): JSX.Element {
	const [scope, setScope] = useState<CommandScope>('global');
	const [formOpen, setFormOpen] = useState(false);
	const [editingName, setEditingName] = useState<string | undefined>(undefined);
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [body, setBody] = useState('');
	const [confirmDeleteName, setConfirmDeleteName] = useState<string | undefined>(undefined);

	const projectAvailable = snapshot?.projectAvailable ?? true;
	const commands = scope === 'global' ? (snapshot?.global ?? []) : (snapshot?.project ?? []);
	const directory = scope === 'global' ? snapshot?.globalDirectory : snapshot?.projectDirectory;
	// 项目作用域在未打开工作区时禁用写操作并展示原因
	const scopeWritable = scope === 'global' || projectAvailable;

	// 写操作成功（savedTick 递增）后关闭表单与删除确认；失败时保留草稿与确认状态
	useEffect(() => {
		if (savedTick === 0) {
			return;
		}
		setFormOpen(false);
		setEditingName(undefined);
		setName('');
		setDescription('');
		setBody('');
		setConfirmDeleteName(undefined);
	}, [savedTick]);

	/** 打开新增 Command 表单并清空字段。 @returns 无返回值。 */
	const handleCreate = (): void => {
		setEditingName(undefined);
		setName('');
		setDescription('');
		setBody('');
		setFormOpen(true);
	};

	/** 打开编辑表单并回填描述（正文不在列表中回显，留空待输入）。 @param cmd 待编辑命令。 @returns 无返回值。 */
	const handleEdit = (cmd: CommandInfo): void => {
		setEditingName(cmd.name);
		setName(cmd.name);
		setDescription(cmd.description ?? '');
		setBody('');
		setFormOpen(true);
	};

	/** 提交保存：创建或更新当前作用域的 Command。 @returns 无返回值。 */
	const handleSave = (): void => {
		if (editingName) {
			onUpdate(scope, editingName, { description: description.trim() || undefined, body });
		} else {
			onCreate(scope, { name: name.trim(), description: description.trim() || undefined, body });
		}
	};

	/** 提交删除确认。 @returns 无返回值。 */
	const handleDelete = (name: string): void => {
		onDelete(scope, name);
		setConfirmDeleteName(undefined);
	};

	return (
		<div className="settings-command-page">
			<div className="settings-heading">
				<span className="settings-eyebrow">能力中心</span>
				<h1>命令</h1>
				<p>将常用提示词保存为可复用模板；命令正文仅作为模型输入，绝不执行。</p>
			</div>
			<section className="settings-card settings-form-card" aria-label="命令作用域">
				<div className="settings-card-header">
					<div>
						<h2>作用域</h2>
						<p>全局命令对所有项目生效，项目命令可覆盖同名全局命令。</p>
					</div>
				</div>
				<div className="settings-form-section">
					<div className="settings-radio-group" role="tablist" aria-label="命令作用域">
						<button
							type="button"
							role="tab"
							aria-selected={scope === 'global'}
							className={`settings-radio settings-scope-tab${scope === 'global' ? ' active' : ''}`}
							onClick={() => setScope('global')}
						>
							全局
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={scope === 'project'}
							className={`settings-radio settings-scope-tab${scope === 'project' ? ' active' : ''}`}
							disabled={!projectAvailable}
							onClick={() => setScope('project')}
						>
							项目
						</button>
					</div>
					{directory ? <p className="settings-target-path">目录 <code>{directory}</code></p> : null}
					{!projectAvailable ? (
						<p className="settings-note settings-note-error">未打开工作区，无法管理项目 Command；全局作用域仍可用。</p>
					) : null}
				</div>
			</section>
			{feedback ? (
				<div className={`settings-feedback ${feedback.kind === 'error' ? 'settings-feedback-error' : ''}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>
					{feedback.message}
				</div>
			) : null}
			<section className="settings-card" aria-label="Command 列表">
				<div className="settings-card-header settings-card-header-list">
					<div>
						<h2 aria-label="命令列表">命令</h2>
						<p>按名称排序；同名项目命令会覆盖全局命令。</p>
					</div>
					<div className="settings-command-list-actions">
						<button type="button" className="settings-secondary-button" onClick={onRefresh} disabled={saving}>↻ 刷新</button>
						<button type="button" className="settings-primary-button" onClick={handleCreate} disabled={saving || !scopeWritable}>+ 创建命令</button>
						<span className="settings-count-badge">{commands.length}</span>
					</div>
				</div>
				{snapshot === null ? (
					<p className="settings-note">正在加载…</p>
				) : commands.length === 0 ? (
					<div className="settings-empty-card">
						<strong>{scope === 'global' ? '暂无全局命令' : '暂无项目命令'}</strong>
						<span>{scope === 'global' ? '创建第一个全局命令后，所有项目均可引用。' : '在项目作用域创建命令，可覆盖同名全局命令。'}</span>
					</div>
				) : (
					<ul className="settings-skill-list">
						{commands.map((cmd) => (
							<li key={`${cmd.scope}-${cmd.name}`} className="settings-row">
								<div>
									<strong>/{cmd.name}</strong>
									<span>{cmd.description || '（无描述）'}</span>
									{cmd.overridden ? <em className="settings-overridden-tag">被项目覆盖</em> : null}
								</div>
								<span className="settings-value">{cmd.sourcePath}</span>
								<div className="settings-model-actions">
									<button type="button" onClick={() => handleEdit(cmd)} disabled={saving || !scopeWritable}>编辑</button>
									{confirmDeleteName === cmd.name ? (
										<span className="mcp-confirm-delete">
											<span>确认删除？</span>
											<button type="button" className="settings-danger-button" onClick={() => handleDelete(cmd.name)} disabled={saving}>确认</button>
											<button type="button" className="settings-secondary-button" onClick={() => setConfirmDeleteName(undefined)}>取消</button>
										</span>
									) : (
										<button type="button" className="settings-danger-action" onClick={() => setConfirmDeleteName(cmd.name)} disabled={saving || !scopeWritable}>删除</button>
									)}
								</div>
							</li>
						))}
					</ul>
				)}
			</section>
			{formOpen ? (
				<section className="settings-card settings-form-card" aria-label={editingName ? '编辑 Command' : '新建 Command'}>
					<div className="settings-card-header">
						<div>
							<h2>{editingName ? `编辑 /${editingName}` : '新建命令'}</h2>
							<p>正文必须非空；名称仅创建时可修改（由文件名决定）。</p>
						</div>
						<span className="settings-status-badge">{scope === 'global' ? '全局' : '项目'}</span>
					</div>
					<div className="settings-form-section">
						<div className="settings-form-grid">
							<label className="settings-field">
								<span className="settings-field-label">命令名</span>
								<input
									value={name}
									onChange={(e) => setName(e.target.value)}
									disabled={Boolean(editingName) || saving}
									placeholder="小写字母/数字开头，可含 - _"
									aria-label="命令名"
								/>
								<span className="settings-field-help">保存后以 <code>{name || '名称'}.md</code> 写入作用域目录。</span>
							</label>
							<label className="settings-field settings-field-wide">
								<span className="settings-field-label">描述（可选）</span>
								<input
									value={description}
									onChange={(e) => setDescription(e.target.value)}
									disabled={saving}
									placeholder="一句话说明该命令的用途"
									aria-label="命令描述"
								/>
							</label>
							<label className="settings-field settings-field-wide">
								<span className="settings-field-label">正文</span>
								<textarea
									value={body}
									onChange={(e) => setBody(e.target.value)}
									rows={5}
									disabled={saving}
									placeholder="输入命令模板正文（作为模型输入，不执行任何代码）"
									aria-label="命令正文"
								/>
								<span className="settings-field-help">正文将作为模型输入文本，不会在扩展宿主中执行。</span>
							</label>
						</div>
					</div>
					<footer className="settings-card-footer">
						<button type="button" className="settings-secondary-button" onClick={() => setFormOpen(false)} disabled={saving}>取消</button>
						<button type="button" className="settings-save-btn" onClick={handleSave} disabled={saving || !name.trim() || !body.trim()}>
							{saving ? '保存中…' : editingName ? '保存修改' : '创建命令'}
						</button>
					</footer>
				</section>
			) : null}
		</div>
	);
}

/** 使用情况分类：受控视图，按粒度与参考周期向宿主请求统计并展示汇总与模型明细。 */
function UsageSettings({
	stats,
	loading,
	error,
	granularity,
	reference,
	onGranularityChange,
	onNavigate,
	onRetry,
}: {
	/** 最近一次统计结果（未加载完成前为 null） */
	stats: TokenUsageStatsResult | null;
	/** 是否正在请求中 */
	loading: boolean;
	/** 整体失败的有界错误消息（可重试） */
	error: string | null;
	/** 当前统计粒度 */
	granularity: UsageGranularity;
	/** 当前参考日期（本地 YYYY-MM-DD） */
	reference: string;
	/** 切换粒度的回调 */
	onGranularityChange: (granularity: UsageGranularity) => void;
	/** 前后周期导航回调（prev=上一周期，next=下一周期） */
	onNavigate: (direction: 'prev' | 'next') => void;
	/** 失败后重试当前请求的回调 */
	onRetry: () => void;
}): JSX.Element {
	const granularityLabel = granularity === 'day' ? '自然日' : granularity === 'week' ? '自然周（周一起）' : '自然月';
	const isEmpty = stats !== null && !loading && stats.total_tokens === 0 && stats.models.length === 0;
	const hasStats = stats !== null && !loading && !error;
	// UI 按 total 降序渲染模型明细（宿主已排序，此处兜底保证展示顺序稳定）
	const sortedModels = stats ? [...stats.models].sort((a, b) => b.total_tokens - a.total_tokens) : [];
	const rangeText = stats
		? `${new Date(stats.start).toLocaleDateString('zh-CN')} 至 ${new Date(stats.end).toLocaleDateString('zh-CN')}`
		: `${new Date(`${reference}T00:00:00`).toLocaleDateString('zh-CN')} 起`;

	return (
		<>
			<div className="settings-heading">
				<span className="settings-eyebrow">透明度</span>
				<h1>使用情况</h1>
				<p>当前工作区本地已记录 token 的模型用量（实际已落账调用，回滚不撤销消耗；不含费用或云端账户统计）。</p>
			</div>
			<section className="settings-card settings-usage-card" aria-label="使用情况统计">
				<div className="settings-card-header settings-card-header-list">
					<div>
						<h2>用量统计</h2>
						<p>按 {granularityLabel} 聚合，区间左闭右开。</p>
					</div>
					<span className="settings-status-badge">本地数据</span>
				</div>
				<div className="settings-usage-toolbar">
					<div className="settings-radio-group" role="radiogroup" aria-label="统计粒度">
						{(['day', 'week', 'month'] as const).map((value) => (
							<label key={value} className="settings-radio">
								<input
									type="radio"
									name="usageGranularity"
									value={value}
									checked={granularity === value}
									disabled={loading}
									onChange={() => onGranularityChange(value)}
								/>
								<span>{value === 'day' ? '日' : value === 'week' ? '周' : '月'}</span>
							</label>
						))}
					</div>
					<div className="settings-usage-nav">
						<button type="button" onClick={() => onNavigate('prev')} disabled={loading} aria-label="上一周期">‹</button>
						<span>{rangeText}</span>
						<button type="button" onClick={() => onNavigate('next')} disabled={loading} aria-label="下一周期">›</button>
					</div>
				</div>
				<div className="settings-card-divider" />
				<div className="settings-usage-body">
					{loading ? (
						<div className="settings-usage-status" role="status">正在统计当前工作区用量…</div>
					) : error ? (
						<div className="settings-usage-status settings-usage-error" role="alert">
							<span>{error}</span>
							<button type="button" className="settings-save-btn" onClick={onRetry}>重试</button>
						</div>
					) : isEmpty ? (
						<div className="settings-empty-card">
							<strong>该时段暂无已记录 token 用量</strong>
							<span>所选时间段内没有已落账的模型调用；切换粒度或时间段后重试。</span>
						</div>
					) : hasStats ? (
						<>
							{stats.partial ? (
								<div className="settings-usage-status settings-usage-warning" role="status">
									部分会话归档无法读取，以下为可用数据（可能不完整）。
								</div>
							) : null}
							<div className="settings-usage-summary" aria-label="用量摘要">
								<div className="settings-usage-total"><span>总量</span><strong>{formatNumber(stats.total_tokens)}</strong></div>
								<div><span>输入</span><strong>{formatNumber(stats.prompt_tokens)}</strong></div>
								<div><span>输出</span><strong>{formatNumber(stats.completion_tokens)}</strong></div>
							</div>
							<div className="settings-usage-table" role="table" aria-label="模型用量明细">
								<div className="settings-usage-table-head" role="row"><span>模型</span><span>输入</span><span>输出</span><span>总量</span><span>缓存读取（输入侧）</span></div>
								{sortedModels.map((row) => (
									<div className="settings-usage-table-row" role="row" key={`${row.provider_id}/${row.model_id}`}>
										<div><strong>{row.model_label}</strong>{row.provider_id !== 'unknown' ? <span className="settings-default-tag">{row.provider_id}</span> : null}</div>
										<span>{formatNumber(row.prompt_tokens)}</span>
										<span>{formatNumber(row.completion_tokens)}</span>
										<span><strong>{formatNumber(row.total_tokens)}</strong></span>
										<span>{row.cache_read_tokens > 0 ? formatNumber(row.cache_read_tokens) : '--'}</span>
									</div>
								))}
							</div>
						</>
					) : null}
				</div>
			</section>
		</>
	);
}

/** Hooks 分类固定样例改写测试结果（本地展示，不持久化）。 */
type HooksTestView = { readonly rewritten?: string; readonly error?: string } | null;

/** Hooks 生命周期节点的静态展示信息。 */
interface HooksLifecycleNode {
	/** 运行时事件名称。 */
	readonly event: 'session_start' | 'pre_tool_call' | 'post_tool_call' | 'session_end';
	/** 面向用户的事件名称。 */
	readonly label: string;
	/** 面向用户的事件说明。 */
	readonly description: string;
}

/** 第一版 Hooks 的固定生命周期顺序。 */
const HOOKS_LIFECYCLE: readonly HooksLifecycleNode[] = [
	{ event: 'session_start', label: '会话开始', description: '准备本次运行环境' },
	{ event: 'pre_tool_call', label: '工具执行前', description: '校验与转换调用参数' },
	{ event: 'post_tool_call', label: '工具执行后', description: '观察受治理的工具结果' },
	{ event: 'session_end', label: '会话结束', description: '收束本次运行状态' },
];

/**
 * Hooks 分类：运行状态、生命周期轨道、RTK 自动化卡片与折叠高级配置。
 * @param config 宿主返回的 Hooks 配置快照。
 * @param rtk 宿主返回的 RTK 检测状态。
 * @param testResult 固定样例改写测试结果。
 * @param saving 是否正在保存、检测或测试。
 * @param onSave 保存 Hooks 配置回调。
 * @param onDetect 重新检测 RTK 回调。
 * @param onTest 测试固定样例改写回调。
 * @returns Hooks 设置页内容。
 */
function HooksSettings({
	config,
	rtk,
	testResult,
	saving,
	onSave,
	onDetect,
	onTest,
}: {
	config: HooksConfigView | null;
	rtk?: RtkStatusView;
	testResult: HooksTestView;
	saving: boolean;
	onSave: (enabled: boolean, rtkEnabled: boolean, rtkExecutablePath?: string) => void;
	onDetect: () => void;
	onTest: () => void;
}): JSX.Element {
	const [enabled, setEnabled] = useState(config?.enabled ?? true);
	const [rtkEnabled, setRtkEnabled] = useState(config?.rtkEnabled ?? false);
	const [path, setPath] = useState(config?.rtkExecutablePath ?? '');
	// 上次同步的配置快照：仅配置实质变化（enabled/rtkEnabled/path）时回填表单，
	// 检测/测试等推送相同配置时不覆盖用户正在编辑的草稿。
	const lastConfigRef = useRef<HooksConfigView | null>(null);

	// 宿主推送新快照时同步本地表单（仅实质变化；不影响模型/Skill/MCP 草稿）
	useEffect(() => {
		if (!config) {
			return;
		}
		const last = lastConfigRef.current;
		lastConfigRef.current = config;
		if (
			!last ||
			last.enabled !== config.enabled ||
			last.rtkEnabled !== config.rtkEnabled ||
			last.rtkExecutablePath !== config.rtkExecutablePath
		) {
			setEnabled(config.enabled);
			setRtkEnabled(config.rtkEnabled);
			setPath(config.rtkExecutablePath ?? '');
		}
	}, [config]);

	/** 保存 Hooks 配置。 @returns void */
	const handleSave = (): void => {
		onSave(enabled, rtkEnabled, path.trim() || undefined);
	};
	const rtkIsActive = enabled && rtkEnabled;
	const rtkState = rtk?.available
		? '已就绪'
		: rtkEnabled
			? '等待检测'
			: '未启用';
	const rtkStateClass = rtk?.available
		? 'ready'
		: rtkEnabled
			? 'warning'
			: 'idle';

	return (
		<>
			<div className="settings-heading hooks-heading">
				<span className="settings-eyebrow">自动化控制台</span>
				<h1>Hooks</h1>
				<p>在关键运行节点执行受信任自动化。当前仅加载扩展内置 Hook，不从工作区、网络或第三方 npm 包加载。</p>
			</div>
			<section className={`settings-card hooks-runtime-card${enabled ? ' is-running' : ' is-paused'}`} aria-label="Hooks 运行状态">
				<div className="hooks-runtime-copy">
					<span className={`hooks-runtime-status ${enabled ? 'is-running' : 'is-paused'}`}><i aria-hidden="true" />{enabled ? '运行中' : '已暂停'}</span>
					<strong>{enabled ? '自动化已接入本次运行' : '自动化不会在后续运行中执行'}</strong>
					<span>{enabled ? '生命周期事件与已启用的集成会按既定顺序运行。' : '重新启用后，已保存的 Hook 配置会恢复生效。'}</span>
				</div>
				<div className="hooks-runtime-control">
					<span>Hooks 运行时</span>
					<button
						type="button"
						role="switch"
						aria-checked={enabled}
						aria-label="Hooks 总开关"
						className={`settings-toggle${enabled ? ' on' : ''}`}
						onClick={() => setEnabled(!enabled)}
						disabled={saving}
					><span /></button>
				</div>
			</section>
			<section className="hooks-lifecycle" aria-labelledby="hooks-lifecycle-title">
				<div className="hooks-section-heading">
					<div>
						<span className="hooks-section-kicker">运行轨道</span>
						<h2 id="hooks-lifecycle-title">生命周期</h2>
					</div>
					<span>4 个基础事件</span>
				</div>
				<ol className="hooks-lifecycle-track">
					{HOOKS_LIFECYCLE.map((node, index) => {
						const configuredCount = node.event === 'pre_tool_call' && rtkEnabled ? 1 : 0;
						const active = node.event === 'pre_tool_call' && rtkIsActive;
						const state = !enabled ? '已暂停' : active ? '已启用' : '待命';
						return (
							<li key={node.event} className={`hooks-lifecycle-node${active ? ' is-active' : ''}${!enabled ? ' is-paused' : ''}`}>
								<span className="hooks-lifecycle-step">0{index + 1}</span>
								<div>
									<strong>{node.label}</strong>
									<span>{node.description}</span>
								</div>
								<footer><span>{configuredCount} 个 Hook</span><em>{state}</em></footer>
							</li>
						);
					})}
				</ol>
			</section>
			<section className={`settings-card hooks-automation-card${rtkIsActive ? ' is-active' : ''}`} aria-label="已启用自动化">
				<header className="hooks-automation-header">
					<div className="hooks-automation-identity">
						<span className="hooks-automation-mark" aria-hidden="true">R</span>
						<div>
							<span className="hooks-section-kicker">已启用自动化</span>
							<h2>RTK · 终端输出优化</h2>
							<p>在工具执行前透明改写支持的终端命令，减少进入上下文的冗余输出。</p>
						</div>
					</div>
					<div className="hooks-automation-controls">
						<span className={`hooks-rtk-state ${rtkStateClass}`}>{rtkState}</span>
						<button
							type="button"
							role="switch"
							aria-checked={rtkEnabled}
							aria-label="RTK 集成开关"
							className={`settings-toggle${rtkEnabled ? ' on' : ''}`}
							onClick={() => setRtkEnabled(!rtkEnabled)}
							disabled={saving}
						><span /></button>
					</div>
				</header>
				<div className="hooks-automation-body">
					<div className="hooks-automation-meta">
						<span>作用范围</span><code>terminal_exec</code>
						{rtk?.version ? <><span>版本</span><code>{rtk.version}</code></> : null}
					</div>
					<div className="hooks-rewrite-flow" aria-label="RTK 改写流程">
						<code>git status</code><span aria-hidden="true">→</span><code>RTK rewrite</code><span aria-hidden="true">→</span><strong>紧凑输出</strong>
					</div>
					{rtk?.error ? <p className="hooks-rtk-error" role="alert">{rtk.error}</p> : null}
					{testResult ? (
						<div className={`hooks-rewrite-result${testResult.error ? ' is-error' : ' is-success'}`} role={testResult.error ? 'alert' : 'status'}>
							<span>改写预览</span>
							{testResult.error ? <strong>{testResult.error}</strong> : <strong><code>git status</code><i aria-hidden="true">→</i><code>{testResult.rewritten}</code></strong>}
						</div>
					) : null}
				</div>
				<details className="hooks-advanced">
					<summary><span>高级配置</span><small>路径、检测与无副作用预览</small></summary>
					<div className="hooks-advanced-content">
						<label className="settings-field">
							<span className="settings-field-label">RTK 可执行文件路径</span>
							<input
								value={path}
								onChange={(e) => setPath(e.target.value)}
								placeholder="例如 C:\\tools\\rtk.exe"
								aria-label="RTK 可执行文件路径"
								disabled={saving}
							/>
							<span className="settings-field-help">未配置时 RTK 不会自动安装；改写失败时会执行原命令。</span>
						</label>
						<footer className="hooks-advanced-actions">
							<button type="button" className="settings-secondary-button" onClick={onDetect} disabled={saving}>重新检测</button>
							<button type="button" className="settings-secondary-button" onClick={onTest} disabled={saving}>测试改写</button>
						</footer>
					</div>
				</details>
			</section>
			<div className="hooks-guardrail" role="note"><i aria-hidden="true" /><span>仅改写 <code>terminal_exec</code>；RTK 不可用或没有等价命令时，系统会执行原命令。</span></div>
			<footer className="hooks-save-bar">
				<span>配置变更会在保存后应用于后续运行。</span>
				<button type="button" className="settings-primary-button" onClick={handleSave} disabled={saving}>保存</button>
			</footer>
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
	hooksConfig,
	rtkStatus,
	hooksTestResult,
	hooksSaving,
	commandSnapshot,
	commandSaving,
	commandFeedback,
	commandSavedTick,
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
	onSaveHooks,
	onDetectRtk,
	onTestRtkRewrite,
	onRefreshCommands,
	onCreateCommand,
	onUpdateCommand,
	onDeleteCommand,
	usageStats,
	usageLoading,
	usageError,
	usageGranularity,
	usageReference,
	onUsageGranularityChange,
	onUsageNavigate,
	onUsageRetry,
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
	hooksConfig: HooksConfigView | null;
	rtkStatus?: RtkStatusView;
	hooksTestResult: HooksTestView;
	hooksSaving: boolean;
	commandSnapshot: CommandSnapshotView | null;
	commandSaving: boolean;
	commandFeedback: CommandFeedback;
	commandSavedTick: number;
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
	/** 保存 Hooks 配置回调。 */
	onSaveHooks: (enabled: boolean, rtkEnabled: boolean, rtkExecutablePath?: string) => void;
	/** 重新检测 RTK 回调。 */
	onDetectRtk: () => void;
	/** 固定样例改写测试回调。 */
	onTestRtkRewrite: () => void;
	/** 手动刷新 Command 回调。 */
	onRefreshCommands: () => void;
	/** 创建 Command 回调。 */
	onCreateCommand: (scope: CommandScope, input: CommandInput) => void;
	/** 编辑 Command 回调。 */
	onUpdateCommand: (scope: CommandScope, name: string, input: CommandInput) => void;
	/** 删除 Command 回调。 */
	onDeleteCommand: (scope: CommandScope, name: string) => void;
	/** 使用情况统计结果（null=未加载完成）。 */
	usageStats: TokenUsageStatsResult | null;
	/** 使用情况是否请求中。 */
	usageLoading: boolean;
	/** 使用情况整体失败消息（null=无错误）。 */
	usageError: string | null;
	/** 使用情况当前粒度。 */
	usageGranularity: UsageGranularity;
	/** 使用情况参考日期（本地 YYYY-MM-DD）。 */
	usageReference: string;
	/** 切换使用情况粒度的回调。 */
	onUsageGranularityChange: (granularity: UsageGranularity) => void;
	/** 使用情况前后周期导航回调。 */
	onUsageNavigate: (direction: 'prev' | 'next') => void;
	/** 使用情况失败重试回调。 */
	onUsageRetry: () => void;
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
	if (section === 'command') {
		return (
			<CommandSettings
				snapshot={commandSnapshot}
				saving={commandSaving}
				feedback={commandFeedback}
				savedTick={commandSavedTick}
				onRefresh={onRefreshCommands}
				onCreate={onCreateCommand}
				onUpdate={onUpdateCommand}
				onDelete={onDeleteCommand}
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
	if (section === 'hooks') {
		return (
			<HooksSettings
				config={hooksConfig}
				rtk={rtkStatus}
				testResult={hooksTestResult}
				saving={hooksSaving}
				onSave={onSaveHooks}
				onDetect={onDetectRtk}
				onTest={onTestRtkRewrite}
			/>
		);
	}
	if (section === 'usage') {
		return (
			<UsageSettings
				stats={usageStats}
				loading={usageLoading}
				error={usageError}
				granularity={usageGranularity}
				reference={usageReference}
				onGranularityChange={onUsageGranularityChange}
				onNavigate={onUsageNavigate}
				onRetry={onUsageRetry}
			/>
		);
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
	// Hooks 状态与模型/Skill/MCP 隔离：快照推送不清空其他分类草稿
	const [hooksConfig, setHooksConfig] = useState<HooksConfigView | null>(null);
	const [rtkStatus, setRtkStatus] = useState<RtkStatusView | undefined>(undefined);
	const [hooksTestResult, setHooksTestResult] = useState<HooksTestView>(null);
	const [hooksSaving, setHooksSaving] = useState(false);
	// 首个快照是挂载时请求的初始化响应，不应结束其间已发起的 Hooks 操作。
	const hooksInitialSnapshotPendingRef = useRef(true);
	// 当前待确认的异步动作：install=安装后等待新快照，source=来源切换后等待新快照（用 ref 供订阅闭包读取最新值）
	const pendingActionRef = useRef<'archive' | 'source' | 'directories' | 'modelAction' | null>(null);
	// ── Command 状态（与模型/Skill/MCP/Hooks 隔离：快照推送不清空其他分类草稿）──
	const [commandSnapshot, setCommandSnapshot] = useState<CommandSnapshotView | null>(null);
	const [commandSaving, setCommandSaving] = useState(false);
	const [commandFeedback, setCommandFeedback] = useState<CommandFeedback>(null);
	/** 写操作成功后递增的计数（CommandSettings 据此关闭表单/删除确认）。 */
	const [commandSavedTick, setCommandSavedTick] = useState(0);
	// 当前待确认的 Command 异步动作（成功后展示反馈并递增 savedTick）
	const commandPendingRef = useRef<'create' | 'update' | 'delete' | 'refresh' | null>(null);
	// ── 使用情况状态（与其他分类草稿隔离：usageStats/usageError 只更新自身，不清空模型/Skill/MCP/Hooks 草稿）──
	const [usageStats, setUsageStats] = useState<TokenUsageStatsResult | null>(null);
	const [usageLoading, setUsageLoading] = useState(false);
	const [usageError, setUsageError] = useState<string | null>(null);
	const [usageGranularity, setUsageGranularity] = useState<UsageGranularity>('day');
	const [usageReference, setUsageReference] = useState(() => todayLocalISO());
	// 是否已发起过首次 usage 请求（进入"使用情况"分类仅请求一次当前自然日，之后由用户筛选变化触发）
	const usageRequestedRef = useRef(false);

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
		post({ command: 'requestCommands' });
		post({ command: 'requestMcpSettings' });
		post({ command: 'requestHooksSnapshot' });
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
					setHooksSaving(false);
					// Command 操作失败：路由到 Command 反馈，保留表单草稿与删除确认状态
					if (commandPendingRef.current) {
						setCommandSaving(false);
						setCommandFeedback({ kind: 'error', message: msg.message });
						commandPendingRef.current = null;
						break;
					}
					pendingActionRef.current = null;
					setFeedback({ kind: 'error', message: msg.message });
					break;
				case 'commandsList': {
					// 状态推送只更新 Command 快照，不影响模型/Skill/MCP/Hooks 草稿
					setCommandSnapshot({
						global: msg.global,
						project: msg.project,
						...(msg.globalDirectory ? { globalDirectory: msg.globalDirectory } : {}),
						...(msg.projectDirectory ? { projectDirectory: msg.projectDirectory } : {}),
						projectAvailable: msg.projectAvailable,
					});
					const pending = commandPendingRef.current;
					if (pending) {
						setCommandSaving(false);
						setCommandFeedback({
							kind: 'success',
							message: pending === 'create' ? '命令已创建，列表已刷新' : pending === 'update' ? '命令已更新，列表已刷新' : pending === 'delete' ? '命令已删除，列表已刷新' : '命令已刷新',
						});
						// 写操作成功：通知 CommandSettings 关闭表单/删除确认（失败时 commandPendingRef 被清空，草稿保留）
						if (pending !== 'refresh') {
							setCommandSavedTick((tick) => tick + 1);
						}
						commandPendingRef.current = null;
					}
					break;
				}
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
				case 'hooksSnapshot':
					// 状态推送只更新 Hooks 快照，不影响模型/Skill/MCP 草稿
					setHooksConfig(msg.config);
					setRtkStatus(msg.rtk);
					if (hooksInitialSnapshotPendingRef.current) {
						hooksInitialSnapshotPendingRef.current = false;
					} else {
						setHooksSaving(false);
					}
					break;
				case 'hooksTestResult':
					setHooksSaving(false);
					setHooksTestResult({ ...(msg.rewritten ? { rewritten: msg.rewritten } : {}), ...(msg.error ? { error: msg.error } : {}) });
					break;
				case 'usageStats':
					// 状态推送只更新使用情况快照，不影响模型/Skill/MCP/Hooks 草稿
					setUsageStats(msg.payload);
					setUsageLoading(false);
					setUsageError(null);
					break;
				case 'usageStatsError':
					setUsageLoading(false);
					setUsageError(msg.message);
					break;
			}
		});
	}, []);

	// 首次进入"使用情况"分类时请求当前自然日；之后由用户切换粒度/周期触发，不在页面挂载时预取。
	useEffect(() => {
		if (activeSection !== 'usage' || usageRequestedRef.current) {
			return;
		}
		usageRequestedRef.current = true;
		const reference = todayLocalISO();
		setUsageReference(reference);
		setUsageLoading(true);
		setUsageError(null);
		post({ command: 'requestUsageStats', granularity: 'day', reference });
	}, [activeSection]);

	/** 发起一次使用情况统计请求。 @param granularity 粒度。 @param reference 参考日期（本地 YYYY-MM-DD）。 @returns 无返回值。 */
	const requestUsage = (granularity: UsageGranularity, reference: string): void => {
		setUsageReference(reference);
		setUsageGranularity(granularity);
		setUsageLoading(true);
		setUsageError(null);
		post({ command: 'requestUsageStats', granularity, reference });
	};

	/** 切换使用情况粒度（保留当前参考日期所在周期）。 @param granularity 目标粒度。 @returns 无返回值。 */
	const handleUsageGranularityChange = (granularity: UsageGranularity): void => {
		if (granularity === usageGranularity) {
			return;
		}
		requestUsage(granularity, usageReference);
	};

	/** 使用情况前后周期导航。 @param direction prev=上一周期，next=下一周期。 @returns 无返回值。 */
	const handleUsageNavigate = (direction: 'prev' | 'next'): void => {
		const base = new Date(`${usageReference}T00:00:00`);
		const delta = usageGranularity === 'day' ? 1 : usageGranularity === 'week' ? 7 : 0;
		let next: Date;
		if (usageGranularity === 'month') {
			next = new Date(base.getFullYear(), base.getMonth() + (direction === 'prev' ? -1 : 1), 1);
		} else {
			next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (direction === 'prev' ? -delta : delta));
		}
		requestUsage(usageGranularity, toLocalISODate(next));
	};

	/** 使用情况请求失败后重试当前粒度与参考日期。 @returns 无返回值。 */
	const handleUsageRetry = (): void => {
		requestUsage(usageGranularity, usageReference);
	};

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

	/** 请求宿主重新扫描双作用域命令并回推最新快照。 */
	const handleRefreshCommands = (): void => {
		setCommandFeedback(null);
		setCommandSaving(true);
		commandPendingRef.current = 'refresh';
		post({ command: 'refreshCommands' });
	};

	/** 提交创建 Command 到宿主。 @param scope 作用域。 @param input 输入。 @returns 无返回值。 */
	const handleCreateCommand = (scope: CommandScope, input: CommandInput): void => {
		setCommandFeedback(null);
		setCommandSaving(true);
		commandPendingRef.current = 'create';
		post({ command: 'createCommand', scope, input });
	};

	/** 提交编辑 Command 到宿主。 @param scope 作用域。 @param name 命令名。 @param input 输入。 @returns 无返回值。 */
	const handleUpdateCommand = (scope: CommandScope, name: string, input: CommandInput): void => {
		setCommandFeedback(null);
		setCommandSaving(true);
		commandPendingRef.current = 'update';
		post({ command: 'updateCommand', scope, name, input });
	};

	/** 提交删除 Command 到宿主。 @param scope 作用域。 @param name 命令名。 @returns 无返回值。 */
	const handleDeleteCommand = (scope: CommandScope, name: string): void => {
		setCommandFeedback(null);
		setCommandSaving(true);
		commandPendingRef.current = 'delete';
		post({ command: 'deleteCommand', scope, name });
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

	/** 保存 Hooks 配置（总开关 + RTK 启用 + 可选路径）。 */
	const handleSaveHooks = (enabled: boolean, rtkEnabled: boolean, rtkExecutablePath?: string): void => {
		setHooksSaving(true);
		post({ command: 'saveHooksConfig', enabled, rtkEnabled, rtkExecutablePath });
	};

	/** 请求重新检测配置的 RTK 可执行文件。 */
	const handleDetectRtk = (): void => {
		setHooksSaving(true);
		post({ command: 'detectRtk' });
	};

	/** 请求固定样例（git status）改写测试。 */
	const handleTestRtkRewrite = (): void => {
		setHooksSaving(true);
		post({ command: 'testRtkRewrite' });
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
				<div className={`settings-content-inner${activeSection === 'command' ? ' settings-command-content-inner' : ''}`}>
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
						hooksConfig={hooksConfig}
						rtkStatus={rtkStatus}
						hooksTestResult={hooksTestResult}
						hooksSaving={hooksSaving}
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
						onSaveHooks={handleSaveHooks}
						onDetectRtk={handleDetectRtk}
						onTestRtkRewrite={handleTestRtkRewrite}
						onRefreshCommands={handleRefreshCommands}
						onCreateCommand={handleCreateCommand}
						onUpdateCommand={handleUpdateCommand}
						onDeleteCommand={handleDeleteCommand}
						commandSnapshot={commandSnapshot}
						commandSaving={commandSaving}
						commandFeedback={commandFeedback}
						commandSavedTick={commandSavedTick}
						usageStats={usageStats}
						usageLoading={usageLoading}
						usageError={usageError}
						usageGranularity={usageGranularity}
						usageReference={usageReference}
						onUsageGranularityChange={handleUsageGranularityChange}
						onUsageNavigate={handleUsageNavigate}
						onUsageRetry={handleUsageRetry}
					/>
				</div>
			</main>
		</section>
	);
}
