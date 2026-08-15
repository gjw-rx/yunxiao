/**
 * model.runtime 配置解析测试 - 验证迁移期 runtime 开关的归一化逻辑。
 *
 * 覆盖：
 * 1. 合法值 'ai-sdk' / 'legacy' 原样返回
 * 2. 非法值（字符串、数字、对象、null）降级为默认 'ai-sdk'
 * 3. undefined 返回默认 'ai-sdk'
 */
import * as assert from 'assert';
import { normalizeRuntime } from '../../config/modelConfig';

describe('modelConfig.normalizeRuntime', () => {
	it('合法值 ai-sdk 原样返回', () => {
		assert.strictEqual(normalizeRuntime('ai-sdk'), 'ai-sdk');
	});

	it('合法值 legacy 原样返回', () => {
		assert.strictEqual(normalizeRuntime('legacy'), 'legacy');
	});

	it('undefined 返回默认 ai-sdk', () => {
		assert.strictEqual(normalizeRuntime(undefined), 'ai-sdk');
	});

	it('非法字符串降级为 ai-sdk', () => {
		assert.strictEqual(normalizeRuntime('invalid'), 'ai-sdk');
		assert.strictEqual(normalizeRuntime('openai'), 'ai-sdk');
		assert.strictEqual(normalizeRuntime('AI-SDK'), 'ai-sdk'); // 大小写敏感
		assert.strictEqual(normalizeRuntime(''), 'ai-sdk');
	});

	it('非字符串类型降级为 ai-sdk', () => {
		assert.strictEqual(normalizeRuntime(123), 'ai-sdk');
		assert.strictEqual(normalizeRuntime(true), 'ai-sdk');
		assert.strictEqual(normalizeRuntime(null), 'ai-sdk');
		assert.strictEqual(normalizeRuntime({ runtime: 'legacy' }), 'ai-sdk');
		assert.strictEqual(normalizeRuntime(['legacy']), 'ai-sdk');
	});
});
