/**
 * 消息输入组件测试。
 * 职责：验证输入工具栏的模型配置弹层（根/模型/推理子视图）、选择协议消息、
 * 返回、Esc/外部点击关闭、焦点恢复与流式禁用。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanStage, SlashCommandGroup } from '../protocol';

const bridge = vi.hoisted(() => ({
	/** 捕获发往扩展宿主的消息。 */
	post: vi.fn(),
}));

vi.mock('../bridge/vscode', () => ({ post: bridge.post }));

import { MessageInput } from '../components/chat/MessageInput';

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
	configurable: true,
	value: vi.fn(),
});

/** 清理每个用例产生的消息记录。 */
afterEach(() => {
	cleanup();
	bridge.post.mockClear();
});

describe('MessageInput', () => {
	/** 当前模型的切换候选项。 */
	const modelProfiles = [
		{ id: 'model-a', model: 'deepseek-v4-flash', provider: 'openai', isDefault: true, reasoningEffort: 'medium' as const },
		{ id: 'model-b', model: 'gpt-4o', provider: 'openai', isDefault: false, reasoningEffort: 'high' as const },
	];

	/** 创建带有模型列表的消息输入组件。 */
	const renderMessageInput = (
		options: {
			isStreaming?: boolean;
			planStage?: PlanStage;
			slashCommandGroups?: SlashCommandGroup[];
			reasoningEffort?: 'low' | 'medium' | 'high';
			modelId?: string;
		} = {},
	): void => {
		render(
			<MessageInput
				currentSessionId="session-1"
				isStreaming={options.isStreaming ?? false}
				modelName="deepseek-v4-flash"
				modelId={options.modelId ?? 'model-a'}
				reasoningEffort={options.reasoningEffort ?? 'medium'}
				approvalMode="request"
				modelProfiles={modelProfiles}
				selectedFiles={[]}
				selectedSkills={[]}
				slashCommandGroups={options.slashCommandGroups ?? []}
				workspaceFiles={[]}
				onDraftConsumed={vi.fn()}
				onRemoveFile={vi.fn()}
				onRemoveSkill={vi.fn()}
				onAddFile={vi.fn()}
				onAddSkill={vi.fn()}
				onSend={vi.fn()}
				planStage={options.planStage ?? 'normal'}
				onTogglePlan={vi.fn()}
			/>,
		);
	};

	/** 打开模型配置弹层（根视图）。 */
	const openRoot = (): void => {
		fireEvent.click(screen.getByRole('button', { name: '切换模型 deepseek-v4-flash' }));
	};

	it('点击当前模型名称时打开根视图并请求模型列表', () => {
		renderMessageInput();
		openRoot();

		expect(bridge.post).toHaveBeenCalledWith({ command: 'requestModelPicker' });
		expect(screen.getByRole('menu', { name: '模型配置' })).toBeTruthy();
		// 根视图展示模型与推理强度两行及当前值
		expect(screen.getByRole('menuitem', { name: '切换模型' })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: '推理强度' })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: '推理强度' }).textContent).toContain('中');
	});

	it('从根视图进入模型子视图并展示已启用模型与当前项', () => {
		renderMessageInput();
		openRoot();
		fireEvent.click(screen.getByRole('menuitem', { name: '切换模型' }));

		expect(screen.getByRole('menuitemradio', { name: 'deepseek-v4-flash' }).getAttribute('aria-checked')).toBe('true');
		expect(screen.getByRole('menuitemradio', { name: 'gpt-4o' })).toBeTruthy();
		// 返回入口
		expect(screen.getByRole('menuitem', { name: '返回' })).toBeTruthy();
	});

	it('从模型子视图返回根视图', () => {
		renderMessageInput();
		openRoot();
		fireEvent.click(screen.getByRole('menuitem', { name: '切换模型' }));
		fireEvent.click(screen.getByRole('menuitem', { name: '返回' }));

		expect(screen.getByRole('menuitem', { name: '切换模型' })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: '推理强度' })).toBeTruthy();
	});

	it('点击模型候选项时请求切换为该模型', () => {
		renderMessageInput();
		openRoot();
		fireEvent.click(screen.getByRole('menuitem', { name: '切换模型' }));
		fireEvent.click(screen.getByRole('menuitemradio', { name: 'gpt-4o' }));

		expect(bridge.post).toHaveBeenCalledWith({ command: 'selectModel', modelId: 'model-b' });
	});

	it('进入推理强度子视图并标记当前档位', () => {
		renderMessageInput({ reasoningEffort: 'high' });
		openRoot();
		fireEvent.click(screen.getByRole('menuitem', { name: '推理强度' }));

		expect(screen.getByRole('menuitemradio', { name: '推理强度 低' })).toBeTruthy();
		expect(screen.getByRole('menuitemradio', { name: '推理强度 中' })).toBeTruthy();
		expect(screen.getByRole('menuitemradio', { name: '推理强度 高' }).getAttribute('aria-checked')).toBe('true');
	});

	it('选择推理强度时提交当前模型 ID 与档位', () => {
		renderMessageInput({ modelId: 'model-a' });
		openRoot();
		fireEvent.click(screen.getByRole('menuitem', { name: '推理强度' }));
		fireEvent.click(screen.getByRole('menuitemradio', { name: '推理强度 低' }));

		expect(bridge.post).toHaveBeenCalledWith({ command: 'selectReasoningLevel', modelId: 'model-a', level: 'low' });
	});

	it('按 Esc 关闭弹层并聚焦回触发按钮', () => {
		renderMessageInput();
		openRoot();
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(screen.queryByRole('menu', { name: '模型配置' })).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: '切换模型 deepseek-v4-flash' }));
	});

	it('点击外部关闭弹层且不改变选择', async () => {
		renderMessageInput();
		openRoot();
		fireEvent.click(screen.getByRole('button', { name: '切换模型 deepseek-v4-flash' }));
		// 点击弹层外部区域触发关闭
		fireEvent.mouseDown(document.body);
		await waitFor(() => {
			expect(screen.queryByRole('menu', { name: '模型配置' })).toBeNull();
		});
	});

	it('流式回复期间模型入口禁用且不打开弹层', () => {
		renderMessageInput({ isStreaming: true });
		const button = screen.getByRole('button', { name: '切换模型 deepseek-v4-flash' });
		expect(button.getAttribute('disabled')).not.toBeNull();
		fireEvent.click(button);
		expect(screen.queryByRole('menu', { name: '模型配置' })).toBeNull();
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
		renderMessageInput({ isStreaming: true });
		const stopButton = screen.getByRole('button', { name: '停止生成' });

		fireEvent.click(stopButton);

		expect(bridge.post).toHaveBeenCalledWith({ command: 'stopStream', sessionId: 'session-1' });
	});

	it('通过 /plan 进入 Plan 模式且不发送普通聊天消息', () => {
		renderMessageInput({
			slashCommandGroups: [{
				id: 'basic',
				label: '基础命令',
				commands: [{
					id: 'basic.plan-mode',
					command: 'plan',
					label: 'Plan 模式',
					description: '进入或退出只读规划模式',
					send: true,
					action: 'planMode',
				}],
			}],
		});
		const input = screen.getByRole('textbox', { name: '消息输入' });

		fireEvent.change(input, { target: { value: '/plan', selectionStart: 5 } });
		fireEvent.keyDown(input, { key: 'Enter' });

		expect(bridge.post).toHaveBeenCalledWith({ command: 'enterPlanMode', sessionId: 'session-1' });
		expect((input as HTMLTextAreaElement).value).toBe('');
	});

	it('规划中 /plan 退出 Plan 模式，执行中入口禁用', () => {
		const commands: SlashCommandGroup[] = [{
			id: 'basic',
			label: '基础命令',
			commands: [{
				id: 'basic.plan-mode',
				command: 'plan',
				label: 'Plan 模式',
				description: '进入或退出只读规划模式',
				send: true,
				action: 'planMode',
			}],
		}];
		renderMessageInput({ planStage: 'planning', slashCommandGroups: commands });
		const input = screen.getByRole('textbox', { name: '消息输入' });
		fireEvent.change(input, { target: { value: '/plan', selectionStart: 5 } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(bridge.post).toHaveBeenCalledWith({ command: 'exitPlanMode', sessionId: 'session-1' });

		cleanup();
		renderMessageInput({ planStage: 'executing', slashCommandGroups: commands });
		expect(screen.getByRole('button', { name: 'Plan 模式：执行中' }).getAttribute('disabled')).not.toBeNull();
	});
});
