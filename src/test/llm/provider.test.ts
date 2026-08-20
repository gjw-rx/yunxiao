import * as assert from 'assert';
import { createProvider } from '../../llm/provider';
import { OpenAIProvider } from '../../llm/openaiProvider';
import { AISDKProvider } from '../../llm/aiSdkProvider';
import type { ModelConfig } from '../../config/modelConfig';

const baseConfig: ModelConfig = {
	provider: 'openai',
	model: 'gpt-4o-mini',
	apiKey: 'sk-test',
	baseURL: 'https://api.openai.com/v1',
	temperature: 0.7,
	maxTokens: 4096,
};

describe('createProvider', () => {
	it('provider=openai 且未配置 runtime 时默认返回 AISDKProvider', () => {
		const provider = createProvider(baseConfig);
		assert.ok(provider instanceof AISDKProvider);
	});

	it('provider=openai 且 runtime=ai-sdk 返回 AISDKProvider', () => {
		const provider = createProvider({ ...baseConfig, runtime: 'ai-sdk' });
		assert.ok(provider instanceof AISDKProvider);
	});

	it('provider=openai 且 runtime=legacy 显式回退 OpenAIProvider', () => {
		const provider = createProvider({ ...baseConfig, runtime: 'legacy' });
		assert.ok(provider instanceof OpenAIProvider);
	});

	it('未知 provider 抛出错误', () => {
		assert.throws(
			() => createProvider({ ...baseConfig, provider: 'unknown' }),
			/不支持的 Provider: unknown/,
		);
	});

	it('provider=anthropic 且未配置 runtime 时默认返回 AISDKProvider', () => {
		const provider = createProvider({ ...baseConfig, provider: 'anthropic', baseURL: 'https://api.anthropic.com/v1' });
		assert.ok(provider instanceof AISDKProvider);
	});

	it('provider=anthropic 且 runtime=ai-sdk 返回 AISDKProvider', () => {
		const provider = createProvider({ ...baseConfig, provider: 'anthropic', baseURL: 'https://api.anthropic.com/v1', runtime: 'ai-sdk' });
		assert.ok(provider instanceof AISDKProvider);
	});

	it('provider=anthropic 且 runtime=legacy 时创建阶段防御性拒绝', () => {
		assert.throws(
			() => createProvider({ ...baseConfig, provider: 'anthropic', baseURL: 'https://api.anthropic.com/v1', runtime: 'legacy' }),
			/Anthropic 模型仅支持 ai-sdk 运行时/,
		);
	});

	it('拒绝组合不发起任何网络请求', () => {
		const original = globalThis.fetch;
		let called = false;
		globalThis.fetch = (async () => { called = true; throw new Error('不应被调用'); }) as typeof fetch;
		try {
			assert.throws(() => createProvider({ ...baseConfig, provider: 'anthropic', runtime: 'legacy' }));
			assert.throws(() => createProvider({ ...baseConfig, provider: 'unknown-provider' }));
		} finally {
			globalThis.fetch = original;
		}
		assert.strictEqual(called, false, '校验拒绝阶段不应发起网络请求');
	});
});
