import * as assert from 'assert';
import {
	PathGuardError,
	ToolNotFoundError,
	ToolTimeoutError,
	ProtocolError,
	ToolValidationError,
	formatErrorForUser,
} from '../../core/errors';

describe('formatErrorForUser', () => {
	it('maps PathGuardError traversal', () => {
		const msg = formatErrorForUser(new PathGuardError('p', 'traversal'));
		assert.ok(msg.includes('越界'));
	});

	it('maps PathGuardError no_workspace', () => {
		const msg = formatErrorForUser(new PathGuardError('p', 'no_workspace'));
		assert.ok(msg.includes('工作区'));
	});

	it('maps PathGuardError symlink_escape', () => {
		const msg = formatErrorForUser(new PathGuardError('p', 'symlink_escape'));
		assert.ok(msg.includes('符号链接'));
	});

	it('maps PathGuardError sensitive', () => {
		const msg = formatErrorForUser(new PathGuardError('p', 'sensitive'));
		assert.ok(msg.includes('敏感'));
	});

	it('maps PathGuardError not_found', () => {
		const msg = formatErrorForUser(new PathGuardError('p', 'not_found'));
		assert.strictEqual(msg, 'p');
	});

	it('maps ToolNotFoundError / ToolTimeoutError', () => {
		assert.ok(formatErrorForUser(new ToolNotFoundError('fs_x')).includes('fs_x'));
		assert.ok(formatErrorForUser(new ToolTimeoutError('fs_x', 1000)).includes('超时'));
	});

	it('maps ToolValidationError and ProtocolError', () => {
		assert.ok(formatErrorForUser(new ToolValidationError('bad')).includes('工具参数无效'));
		assert.ok(formatErrorForUser(new ProtocolError('boom')).includes('boom'));
	});

	it('maps generic Error and non-Error', () => {
		assert.strictEqual(formatErrorForUser(new Error('oops')), 'oops');
		assert.strictEqual(formatErrorForUser('plain string'), 'plain string');
	});
});
