/**
 * 代码变更查看页的 Git 风格差异展示测试。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebviewMessage } from '../protocol';

const bridge = vi.hoisted(() => ({
	/** 宿主消息订阅回调。 */
	listener: undefined as undefined | ((message: HostToWebviewMessage) => void),
	/** Webview 向宿主发送的消息记录。 */
	post: vi.fn(),
}));

vi.mock('../bridge/vscode', () => ({
	post: bridge.post,
	subscribe: (listener: (message: HostToWebviewMessage) => void) => {
		bridge.listener = listener;
		return (): void => undefined;
	},
}));

import { ChangeReviewPage } from '../components/changes/ChangeReviewPage';

afterEach(() => {
	cleanup();
	bridge.listener = undefined;
	bridge.post.mockClear();
});

describe('ChangeReviewPage', () => {
	/** 将文件元数据呈现在接近编辑器标签页的差异栏，并按两栏显示隐藏上下文。 */
	it('以编辑器标签栏呈现文件与增删统计，并在两侧提示折叠的上下文行数', () => {
		render(<ChangeReviewPage />);
		act(() => bridge.listener?.({
			command: 'changeReviewSummary',
			summary: {
				id: '1', fileCount: 1, additions: 1, deletions: 1,
				files: [{ id: 'file-1', relativePath: 'src/example.ts', status: 'modified', additions: 1, deletions: 1 }],
			},
		}));

		fireEvent.click(screen.getByRole('button', { name: /src\/example\.ts/ }));
		act(() => bridge.listener?.({
			command: 'changeReviewFile',
			file: {
				id: 'file-1', relativePath: 'src/example.ts', status: 'modified', additions: 1, deletions: 1,
				before: `${Array.from({ length: 10 }, (_, index) => `before-${index + 1}`).join('\n')}\nold value\n${Array.from({ length: 10 }, (_, index) => `after-${index + 1}`).join('\n')}\n`,
				after: `${Array.from({ length: 10 }, (_, index) => `before-${index + 1}`).join('\n')}\nnew value\n${Array.from({ length: 10 }, (_, index) => `after-${index + 1}`).join('\n')}\n`,
			},
		}));

		const fileTab = screen.getByTestId('change-diff-file-tab').textContent;
		expect(fileTab).toContain('example.ts');
		expect(fileTab).toContain('src');
		expect(fileTab).toContain('+1');
		expect(screen.getAllByTestId('change-diff-hidden-lines')).toHaveLength(2);
		expect(screen.getAllByText('4 个隐藏的行')).toHaveLength(4);
	});

	/** 将同一处替换展示为带行号、上下文与字符级高亮的并排差异。 */
	it('将修改内容按 Git 风格标记为删除和新增，并保留未修改上下文', () => {
		render(<ChangeReviewPage />);
		act(() => bridge.listener?.({
			command: 'changeReviewSummary',
			summary: {
				id: '1', fileCount: 1, additions: 1, deletions: 1,
				files: [{ id: 'file-1', relativePath: 'src/example.ts', status: 'modified', additions: 1, deletions: 1 }],
			},
		}));

		fireEvent.click(screen.getByRole('button', { name: /src\/example\.ts/ }));
		act(() => bridge.listener?.({
			command: 'changeReviewFile',
			file: {
				id: 'file-1', relativePath: 'src/example.ts', status: 'modified', additions: 1, deletions: 1,
				before: 'const version = 1;\nconsole.log(version);\n',
				after: 'const version = 2;\nconsole.log(version);\n',
			},
		}));

		expect(screen.getAllByTestId('change-diff-row')).toHaveLength(2);
		expect(screen.getByTestId('change-diff-row-removed').textContent).toContain('1');
		expect(screen.getByTestId('change-diff-row-added').textContent).toContain('2');
		expect(screen.getAllByTestId('change-diff-row-context')).toHaveLength(1);
		expect(document.querySelectorAll('.change-diff-line-highlight')).toHaveLength(2);
	});
});
