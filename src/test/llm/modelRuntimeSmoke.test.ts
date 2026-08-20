/**
 * 模型运行时加载 smoke test（Task 1.3）。
 *
 * 验证 OpenAI-compatible 与 Anthropic 两个 AI SDK Provider 包均能在当前
 * Extension Host 运行时（`npm test` 实际执行的 Node 版本）正常加载并构造模型实例，
 * 不发起任何网络请求。用于提前发现依赖版本与运行时不兼容的问题（design.md 风险 1）。
 */
import * as assert from 'assert';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';

describe('模型运行时加载 smoke test', () => {
	it('OpenAI-compatible Provider 包可加载并构造模型实例', () => {
		const provider = createOpenAICompatible({
			name: 'openai-compatible',
			baseURL: 'https://api.openai.com/v1',
			apiKey: 'sk-test',
		});
		const model = provider('gpt-4o-mini');
		assert.ok(model, 'OpenAI-compatible 模型实例应成功构造');
		assert.strictEqual(model.modelId, 'gpt-4o-mini');
	});

	it('Anthropic Provider 包可加载并构造模型实例', () => {
		const provider = createAnthropic({
			baseURL: 'https://api.anthropic.com/v1',
			apiKey: 'sk-ant-test',
		});
		const model = provider('claude-3-5-sonnet-latest');
		assert.ok(model, 'Anthropic 模型实例应成功构造');
		assert.strictEqual(model.modelId, 'claude-3-5-sonnet-latest');
	});
});
