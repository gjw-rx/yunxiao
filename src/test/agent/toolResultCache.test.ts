import * as assert from 'assert';
import { ToolResultCache } from '../../agent/toolResultCache';
import type { ToolResult } from '../../core/types';

describe('ToolResultCache', () => {
	let cache: ToolResultCache;

	const successResult: ToolResult = {
		call_id: 'call-1',
		status: 'success',
		result: 'file content here',
	};

	const errorResult: ToolResult = {
		call_id: 'call-2',
		status: 'error',
		error: 'file not found',
	};

	beforeEach(() => {
		cache = new ToolResultCache();
	});

	describe('has / get', () => {
		it('未缓存时 has 返回 false', () => {
			assert.strictEqual(cache.has('read_file', { path: '/a.ts' }), false);
		});

		it('缓存后 has 返回 true', () => {
			cache.set('read_file', { path: '/a.ts' }, successResult);
			assert.strictEqual(cache.has('read_file', { path: '/a.ts' }), true);
		});

		it('缓存后 get 返回结果', () => {
			cache.set('read_file', { path: '/a.ts' }, successResult);
			const result = cache.get('read_file', { path: '/a.ts' });
			assert.deepStrictEqual(result, successResult);
		});

		it('不同参数不命中', () => {
			cache.set('read_file', { path: '/a.ts' }, successResult);
			assert.strictEqual(cache.has('read_file', { path: '/b.ts' }), false);
		});

		it('参数顺序不同但内容相同命中', () => {
			cache.set('read_file', { path: '/a.ts', offset: 0 }, successResult);
			assert.strictEqual(cache.has('read_file', { offset: 0, path: '/a.ts' }), true);
		});
	});

	describe('set', () => {
		it('不缓存 error 结果', () => {
			cache.set('read_file', { path: '/a.ts' }, errorResult);
			assert.strictEqual(cache.has('read_file', { path: '/a.ts' }), false);
		});

		it('仅缓存 success 结果', () => {
			cache.set('read_file', { path: '/a.ts' }, successResult);
			assert.strictEqual(cache.has('read_file', { path: '/a.ts' }), true);
		});
	});

	describe('新 run 缓存为空', () => {
		it('新实例缓存为空', () => {
			const fresh = new ToolResultCache();
			assert.strictEqual(fresh.has('read_file', { path: '/a.ts' }), false);
		});
	});
});
