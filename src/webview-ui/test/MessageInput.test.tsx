/**
 * 消息输入组件测试。
 * 职责：验证输入工具栏的模型切换入口会向扩展宿主发送正确的协议消息。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
	/** 捕获发往扩展宿主的消息。 */
	post: vi.fn(),
}));

vi.mock('../bridge/vscode', () => ({ post: bridge.post }));

import { MessageInput } from '../components/chat/MessageInput';

/** 清理每个用例产生的消息记录。 */
afterEach(() => {
	bridge.post.mockClear();
});

describe('MessageInput', () => {
	/** 点击当前模型名称时，请求宿主打开已启用模型的选择器。 */
	it('点击当前模型名称时请求切换模型', () => {
		render(
			<MessageInput
				currentSessionId="session-1"
				isStreaming={false}
				modelName="deepseek-v4-flash"
				selectedFiles={[]}
				selectedSkills={[]}
				slashCommandGroups={[]}
				workspaceFiles={[]}
				onRemoveFile={vi.fn()}
				onRemoveSkill={vi.fn()}
				onAddFile={vi.fn()}
				onAddSkill={vi.fn()}
				onSend={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole('button', { name: '切换模型 deepseek-v4-flash' }));

		expect(bridge.post).toHaveBeenCalledWith({ command: 'switchModel' });
	});
});
