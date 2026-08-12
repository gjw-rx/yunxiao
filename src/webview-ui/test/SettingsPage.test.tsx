/**
 * 设置页组件测试。
 *
 * 职责：验证设置页默认分类、分类切换与静态展示边界。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../components/settings/SettingsPage';

afterEach(cleanup);

describe('SettingsPage', () => {
	/** 默认展示模型分类，并说明该界面尚未接入保存能力。 */
	it('默认展示模型分类的静态配置说明', () => {
		render(<SettingsPage onClose={vi.fn()} />);

		expect(screen.getByRole('heading', { name: '模型' })).toBeTruthy();
		expect(screen.getByText('设置变更将在后续版本接入')).toBeTruthy();
	});

	/** 点击分类只切换静态内容，不触发宿主通信。 */
	it('可切换到 Skill 与使用情况分类', () => {
		render(<SettingsPage onClose={vi.fn()} />);

		fireEvent.click(screen.getByRole('button', { name: 'Skill' }));
		expect(screen.getByRole('heading', { name: 'Skill' })).toBeTruthy();
		expect(screen.getByText('Skill 管理将在后续版本接入')).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: '使用情况' }));
		expect(screen.getByRole('heading', { name: '使用情况' })).toBeTruthy();
		expect(screen.getByText('使用情况数据将在后续版本接入')).toBeTruthy();
	});
});
