/**
 * 工具步骤组件的读取复用状态展示测试。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolStep } from '../components/tools/ToolStep';

afterEach(() => {
	cleanup();
});

describe('ToolStep', () => {
	it('读取结果复用时展示明确状态', () => {
		render(
			<ToolStep
				entry={{
					call_id: 'call-1',
					tool: 'fs_read_file',
					state: 'success',
					output: '已复用当前轮已读取内容',
					reused: true,
					expanded: false,
				}}
				onToggle={() => {}}
			/>,
		);

		expect(screen.getByText('已复用读取结果')).toBeTruthy();
	});

	it('文件正文包含旧标记但未复用时不显示复用状态', () => {
		render(
			<ToolStep
				entry={{
					call_id: 'call-2',
					tool: 'fs_read_file',
					state: 'success',
					output: '<read_reuse>这是文件正文，不是工具状态</read_reuse>',
					reused: false,
					expanded: false,
				}}
				onToggle={() => {}}
				/>,
		);

		expect(screen.queryByText('已复用读取结果')).toBeNull();
	});
});
