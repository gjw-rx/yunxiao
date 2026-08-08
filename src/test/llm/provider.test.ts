import * as assert from 'assert';
import { createProvider } from '../../llm/provider';
import { OpenAIProvider } from '../../llm/openaiProvider';
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
	it('provider=openai 返回 OpenAIProvider', () => {
		const provider = createProvider(baseConfig);
		assert.ok(provider instanceof OpenAIProvider);
	});

	it('未知 provider 抛出错误', () => {
		assert.throws(
			() => createProvider({ ...baseConfig, provider: 'unknown' }),
			/不支持的 Provider: unknown/,
		);
	});
});
