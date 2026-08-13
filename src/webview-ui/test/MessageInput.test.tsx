/**
 * 消息输入组件测试。
 * 职责：验证输入工具栏的模型切换入口会向扩展宿主发送正确的协议消息。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
	/** 捕获发往扩展宿主的消息。 */
	post: vi.fn(),
}));

vi.mock('../bridge/vscode', () => ({ post: bridge.post }));

import { MessageInput } from '../components/chat/MessageInput';

/** 清理每个用例产生的消息记录。 */
afterEach(() => {
	cleanup();
	bridge.post.mockClear();
});

describe('MessageInput', () => {
	/** 当前模型的切换候选项。 */
	const modelProfiles = [
		{ id: 'model-a', model: 'deepseek-v4-flash', provider: 'openai', isDefault: true },
		{ id: 'model-b', model: 'gpt-4o', provider: 'openai', isDefault: false },
	];

	/** 创建带有模型列表的消息输入组件。 */
	const renderMessageInput = (isStreaming = false): void => {
		render(
			<MessageInput
				currentSessionId="session-1"
				isStreaming={isStreaming}
				modelName="deepseek-v4-flash"
				approvalMode="request"
				modelProfiles={modelProfiles}
				selectedFiles={[]}
				selectedSkills={[]}
				slashCommandGroups={[]}
				workspaceFiles={[]}
				onDraftConsumed={vi.fn()}
				onRemoveFile={vi.fn()}
				onRemoveSkill={vi.fn()}
				onAddFile={vi.fn()}
				onAddSkill={vi.fn()}
				onSend={vi.fn()}
			/>,
		);
	};

	/** 点击当前模型名称时，在输入框内打开模型选择弹窗。 */
	it('点击当前模型名称时打开模型选择弹窗', () => {
		renderMessageInput();

		fireEvent.click(screen.getByRole('button', { name: '切换模型 deepseek-v4-flash' }));

		expect(bridge.post).toHaveBeenCalledWith({ command: 'requestModelPicker' });
		expect(screen.getByRole('menu', { name: '选择模型' })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: 'gpt-4o' })).toBeTruthy();
	});

	/** 在模型选择弹窗中点击候选项时，向宿主提交目标模型 ID。 */
	it('点击模型候选项时请求切换为该模型', () => {
		renderMessageInput();
		fireEvent.click(screen.getByRole('button', { name: '切换模型 deepseek-v4-flash' }));
		fireEvent.click(screen.getByRole('menuitem', { name: 'gpt-4o' }));

		expect(bridge.post).toHaveBeenCalledWith({ command: 'selectModel', modelId: 'model-b' });
	});

	it('审批模式菜单说明完全访问的删除保护并提交切换请求', () => {
		renderMessageInput();
		fireEvent.click(screen.getByRole('button', { name: '当前审批模式：请求批准' }));
		expect(screen.getByRole('menu', { name: '选择审批模式' })).toBeTruthy();
		const fullAccess = screen.getByRole('menuitemradio', { name: /完全访问/ });
		expect(fullAccess.textContent).toContain('删除操作仍需确认');
		fireEvent.click(fullAccess);
		expect(bridge.post).toHaveBeenCalledWith({ command: 'setApprovalMode', mode: 'full-access' });
	});

	it('按 Escape 关闭审批模式菜单', () => {
		renderMessageInput();
		fireEvent.click(screen.getByRole('button', { name: '当前审批模式：请求批准' }));
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(screen.queryByRole('menu', { name: '选择审批模式' })).toBeNull();
	});

	it('流式回复期间显示停止生成按钮并发送中断请求', () => {
		renderMessageInput(true);
		const stopButton = screen.getByRole('button', { name: '停止生成' });

		fireEvent.click(stopButton);

		expect(bridge.post).toHaveBeenCalledWith({ command: 'stopStream', sessionId: 'session-1' });
	});
});
