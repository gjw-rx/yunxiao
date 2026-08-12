/**
 * AgentLoop 会话任务上下文注入测试。
 */
import * as assert from 'assert';
import { AgentLoop } from '../../agent/agentLoop';
import { EventBus } from '../../core/eventBus';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import type { LLMEvent, LLMProvider, LLMRequest } from '../../llm/types';
import { MessageStore } from '../../memory/messageStore';
import type { SessionTodoStore } from '../../memory/sessionTodoStore';

/** 记录请求且立即结束的 LLM 提供者。 */
class CapturingProvider implements LLMProvider {
	/** 已接收的请求。 */
	readonly requests: LLMRequest[] = [];

	/**
	 * 记录请求并返回一条最终文本。
	 * @param request 本轮 LLM 请求。
	 * @returns 流式响应事件。
	 */
	async *chatCompletion(request: LLMRequest): AsyncGenerator<LLMEvent> {
		this.requests.push(request);
		yield { type: 'textDelta', text: '完成' };
		yield { type: 'finish', reason: 'stop' };
	}
}

describe('AgentLoop todo context', () => {
	it('将未结束任务临时注入请求，但不写入会话历史', async () => {
		const provider = new CapturingProvider();
		const store = new MessageStore();
		const registry = new ToolRegistry();
		const todoStore = {
			formatActiveContext: () => '当前会话的任务进度：\n- [进行中] implement. 实现任务面板',
		} as unknown as SessionTodoStore;
		const loop = new AgentLoop(provider, store, new ToolRouter(registry), registry, new EventBus(), {
			model: 'test-model',
			temperature: 0,
			maxTokens: 128,
			maxSteps: 3,
			workspaceRoots: [],
			todoStore,
		});

		await loop.run('s1', '继续实现');

		assert.ok(provider.requests[0].messages.some((message) => message.content.includes('实现任务面板')));
		assert.ok(!store.loadHistory('s1').some((message) => 'content' in message && message.content.includes('实现任务面板')));
	});
});
