import * as assert from 'assert';
import { ToolCallTracker } from '../../agent/toolCallTracker';

describe('ToolCallTracker', () => {
	let tracker: ToolCallTracker;

	beforeEach(() => {
		tracker = new ToolCallTracker();
	});

	describe('check', () => {
		it('首次调用返回 1', () => {
			const count = tracker.check('read_file', { path: '/a.ts' });
			assert.strictEqual(count, 1);
		});

		it('连续相同调用递增计数', () => {
			tracker.check('read_file', { path: '/a.ts' });
			tracker.check('read_file', { path: '/a.ts' });
			const count = tracker.check('read_file', { path: '/a.ts' });
			assert.strictEqual(count, 3);
		});

		it('不同参数重置计数为 1', () => {
			tracker.check('read_file', { path: '/a.ts' });
			tracker.check('read_file', { path: '/a.ts' });
			const count = tracker.check('read_file', { path: '/b.ts' });
			assert.strictEqual(count, 1);
		});

		it('不同工具名重置计数为 1', () => {
			tracker.check('read_file', { path: '/a.ts' });
			tracker.check('read_file', { path: '/a.ts' });
			const count = tracker.check('list_dir', { path: '/a.ts' });
			assert.strictEqual(count, 1);
		});

		it('参数顺序不同但内容相同视为相同调用', () => {
			tracker.check('read_file', { path: '/a.ts', offset: 0 });
			const count = tracker.check('read_file', { offset: 0, path: '/a.ts' });
			assert.strictEqual(count, 2);
		});
	});

	describe('reset', () => {
		it('重置后首次调用返回 1', () => {
			tracker.check('read_file', { path: '/a.ts' });
			tracker.check('read_file', { path: '/a.ts' });
			tracker.reset();
			const count = tracker.check('read_file', { path: '/a.ts' });
			assert.strictEqual(count, 1);
		});

		it('重置后计数器清零', () => {
			tracker.check('read_file', { path: '/a.ts' });
			tracker.reset();
			tracker.check('read_file', { path: '/a.ts' });
			tracker.check('read_file', { path: '/a.ts' });
			const count = tracker.check('read_file', { path: '/a.ts' });
			assert.strictEqual(count, 3);
		});
	});
});
