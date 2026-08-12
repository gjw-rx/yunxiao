/**
 * Webview 设置页组件。
 *
 * 职责：在不调用扩展宿主的前提下，展示模型、Skill 与使用情况的静态设置界面。
 */
import { useState, type JSX } from 'react';

/** 设置分类标识。 */
type SettingsSection = 'model' | 'skill' | 'usage';

/** 设置分类导航项。 */
interface SettingsNavItem {
	/** 分类标识。 */
	readonly id: SettingsSection;
	/** 显示名称。 */
	readonly label: string;
	/** 简短说明。 */
	readonly description: string;
}

/** 设置页分类列表。 */
const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
	{ id: 'model', label: '模型', description: '服务与生成参数' },
	{ id: 'skill', label: 'Skill', description: '能力与工作流' },
	{ id: 'usage', label: '使用情况', description: '用量与统计' },
];

/** 设置页属性。 */
export interface SettingsPageProps {
	/** 返回聊天页。 */
	onClose: () => void;
}

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

/** 返回聊天页图标。 */
function BackIcon(): JSX.Element {
	return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m8 3-5 5 5 5M3.5 8H14" /></svg>;
}

/** 模型分类静态内容。 */
function ModelSettings(): JSX.Element {
	return (
		<>
			<div className="settings-heading">
				<span className="settings-eyebrow">运行环境</span>
				<h1>模型</h1>
				<p>查看云效 Agent 的模型连接与生成偏好。当前页面仅用于展示。</p>
			</div>
			<section className="settings-card" aria-label="模型连接">
				<div className="settings-row">
					<div><strong>模型服务</strong><span>当前由 VS Code 配置提供</span></div><span className="settings-value">待接入</span>
				</div>
				<div className="settings-row">
					<div><strong>默认模型</strong><span>用于后续新建会话</span></div><span className="settings-value">待接入</span>
				</div>
				<div className="settings-row">
					<div><strong>生成偏好</strong><span>温度与最大输出长度</span></div><span className="settings-value">待接入</span>
				</div>
			</section>
			<p className="settings-note">设置变更将在后续版本接入</p>
		</>
	);
}

/** Skill 分类静态内容。 */
function SkillSettings(): JSX.Element {
	return (
		<>
			<div className="settings-heading">
				<span className="settings-eyebrow">能力中心</span>
				<h1>Skill</h1>
				<p>集中查看项目可用的工作流与专业能力。</p>
			</div>
			<section className="settings-card settings-empty-card" aria-label="Skill 管理">
				<div className="settings-empty-icon"><SettingsSectionIcon section="skill" /></div>
				<strong>Skill 管理将在后续版本接入</strong>
				<span>届时可在这里浏览、启用和管理可用 Skill。</span>
			</section>
		</>
	);
}

/** 使用情况分类静态内容。 */
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
function SettingsContent({ section }: { section: SettingsSection }): JSX.Element {
	if (section === 'skill') {
		return <SkillSettings />;
	}
	if (section === 'usage') {
		return <UsageSettings />;
	}
	return <ModelSettings />;
}

/** 设置页：分类导航与静态内容展示。 */
export function SettingsPage({ onClose }: SettingsPageProps): JSX.Element {
	const [activeSection, setActiveSection] = useState<SettingsSection>('model');

	return (
		<section className="settings-page" aria-label="设置">
			<aside className="settings-nav" aria-label="设置分类">
				<button type="button" className="settings-back" onClick={onClose}>
					<BackIcon />
					<span>返回聊天</span>
				</button>
				<div className="settings-brand"><span className="settings-brand-mark">Y</span><span>云效 Agent</span></div>
				<div className="settings-nav-label">设置</div>
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
							<span><strong>{item.label}</strong><small>{item.description}</small></span>
						</button>
					))}
				</nav>
			</aside>
			<main className="settings-content">
				<div className="settings-content-inner"><SettingsContent section={activeSection} /></div>
			</main>
		</section>
	);
}
