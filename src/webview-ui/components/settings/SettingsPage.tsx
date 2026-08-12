/**
 * Webview 设置页组件。
 *
 * 职责：通过受控消息协议与扩展宿主交互——
 * - 模型分类：加载并保存模型配置（API Key 仅显示"已配置"状态，密钥不回传页面）
 * - Skill 分类：展示已加载 Skill 列表与来源，切换配置来源，安装项目 Skill 并展示反馈
 * - 使用情况分类：保持静态占位（不请求真实 token、费用或账户数据）
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { post, subscribe } from '../../bridge/vscode';
import type {
	HostToWebviewMessage,
	ModelSettingsInput,
	ModelSettingsView,
	SkillInfo,
	SyncSource,
} from '../../protocol';

/** 设置分类标识。 */
type SettingsSection = 'model' | 'skill' | 'usage';

/** 设置分类导航项。 */
interface SettingsNavItem {
	/** 分类标识。 */
	readonly id: SettingsSection;
	/** 显示名称。 */
	readonly label: string;
}

/** 设置页分类列表。 */
const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
	{ id: 'model', label: '模型' },
	{ id: 'skill', label: 'Skill' },
	{ id: 'usage', label: '使用情况' },
];

/** 配置来源选项（三值互斥，默认 claude）。 */
const SOURCE_OPTIONS: readonly { value: SyncSource; label: string }[] = [
	{ value: 'claude', label: 'Claude' },
	{ value: 'trae', label: 'Trae' },
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
						<span className="settings-field-help">来源之间互斥，切换后会立即重新加载。</span>
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

/** 根据当前分类渲染右侧内容。 */
function SettingsContent({
	section,
	model,
	skills,
	source,
	directories,
	installTarget,
	saving,
	onSaveModel,
	onSetDefaultModel,
	onSetModelEnabled,
	onDeleteModel,
	onSourceChange,
	onDirectoriesSave,
	onUploadArchive,
}: {
	section: SettingsSection;
	model: ModelSettingsView | null;
	skills: SkillInfo[] | null;
	source: SyncSource;
	directories: string[];
	installTarget?: string;
	saving: boolean;
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
	// 当前待确认的异步动作：install=安装后等待新快照，source=来源切换后等待新快照（用 ref 供订阅闭包读取最新值）
	const pendingActionRef = useRef<'archive' | 'source' | 'directories' | 'modelAction' | null>(null);

	// 挂载时请求初始数据并订阅宿主响应
	useEffect(() => {
		post({ command: 'requestModelSettings' });
		post({ command: 'requestSkills' });
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
						onSaveModel={handleSaveModel}
						onSetDefaultModel={handleSetDefaultModel}
						onSetModelEnabled={handleSetModelEnabled}
						onDeleteModel={handleDeleteModel}
						onSourceChange={handleSourceChange}
						onDirectoriesSave={handleDirectoriesSave}
						onUploadArchive={handleUploadArchive}
					/>
				</div>
			</main>
		</section>
	);
}
