/**
 * 候选选择器滚动测试。
 *
 * 职责：确保键盘导航改变高亮项时，当前候选项会滚动到可见区域。
 */
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlashCommandPicker, type FilteredSlashCommand } from '../components/commands/SlashCommandPicker';
import { FilePicker } from '../components/files/FilePicker';

/** 斜杠命令候选数据。 */
const slashCommands: FilteredSlashCommand[] = [
	{ id: 'command.first', command: 'first', label: 'First', description: '', send: false, groupLabel: '基础命令' },
	{ id: 'command.second', command: 'second', label: 'Second', description: '', send: false, groupLabel: '基础命令' },
];

/** 文件候选数据。 */
const files = [
	{ name: 'first.ts', path: 'src/first.ts' },
	{ name: 'second.ts', path: 'src/second.ts' },
];

/** 测试前的 scrollIntoView 属性描述。 */
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

/** 恢复测试期间替换的 DOM 方法。 */
afterEach(() => {
	vi.restoreAllMocks();
	if (originalScrollIntoView) {
		Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
	} else {
		Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
	}
});

describe('候选选择器滚动', () => {
	/** 当前斜杠命令高亮变化时，将其滚动到可见区域。 */
	it('斜杠命令高亮变化时滚动当前项', () => {
		const scrollIntoView = vi.fn();
		Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
		const { rerender } = render(
			<SlashCommandPicker commands={slashCommands} activeIndex={0} onSelect={vi.fn()} onClose={vi.fn()} />,
		);

		scrollIntoView.mockClear();
		rerender(<SlashCommandPicker commands={slashCommands} activeIndex={1} onSelect={vi.fn()} onClose={vi.fn()} />);

		expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
	});

	/** 当前文件高亮变化时，将其滚动到可见区域。 */
	it('文件高亮变化时滚动当前项', () => {
		const scrollIntoView = vi.fn();
		Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
		const { rerender } = render(<FilePicker files={files} activeIndex={0} onSelect={vi.fn()} onClose={vi.fn()} />);

		scrollIntoView.mockClear();
		rerender(<FilePicker files={files} activeIndex={1} onSelect={vi.fn()} onClose={vi.fn()} />);

		expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
	});
});
