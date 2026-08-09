import * as assert from 'assert';
import { DoomLoopDetector } from '../../agent/doomLoopDetector';
import type { ToolCall } from '../../memory/types';

function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
	return { id: '1', name, arguments: JSON.stringify(args) };
}

describe('DoomLoopDetector', () => {
	let detector: DoomLoopDetector;

	beforeEach(() => {
		detector = new DoomLoopDetector();
	});

	describe('check', () => {
		it('首次调用不触发 doom', () => {
			const result = detector.check(makeToolCall('read_file', { path: '/a.ts' }));
			assert.strictEqual(result.isDoom, false);
		});

		it('两次相同调用不触发 doom', () => {
			detector.check(makeToolCall('read_file', { path: '/a.ts' }));
			const result = detector.check(makeToolCall('read_file', { path: '/a.ts' }));
			assert.strictEqual(result.isDoom, false);
		});

		it('连续3次相同调用触发 doom', () => {
			detector.check(makeToolCall('read_file', { path: '/a.ts' }));
			detector.check(makeToolCall('read_file', { path: '/a.ts' }));
			const result = detector.check(makeToolCall('read_file', { path: '/a.ts' }));
			assert.strictEqual(result.isDoom, true);
			assert.strictEqual(result.tool, 'read_file');
		});

		it('不同参数不触发 doom', () => {
			detector.check(makeToolCall('read_file', { path: '/a.ts' }));
			detector.check(makeToolCall('read_file', { path: '/a.ts' }));
			const result = detector.check(makeToolCall('read_file', { path: '/b.ts' }));
			assert.strictEqual(result.isDoom, false);
		});

		it('交替模式不触发 doom (A→B→A)', () => {
			detector.check(makeToolCall('read_file', { path: '/a.ts' }));
			detector.check(makeToolCall('list_dir', { path: '/' }));
			const result = detector.check(makeToolCall('read_file', { path: '/a.ts' }));
			assert.strictEqual(result.isDoom, false);
		});
	});

	describe('reset', () => {
		it('重置后首次调用不触发 doom', () => {
			detector.check(makeToolCall('read_file', { path: '/a.ts' }));
			detector.check(makeToolCall('read_file', { path: '/a.ts' }));
			detector.reset();
			const result = detector.check(makeToolCall('read_file', { path: '/a.ts' }));
			assert.strictEqual(result.isDoom, false);
		});
	});
});
