import * as assert from 'assert';
import * as path from 'path';
import {
	resolveWithinRoots,
	isSensitivePath,
	type PathGuardOptions,
} from '../../../tools/fs/pathGuard';
import { PathGuardError } from '../../../core/errors';

describe('pathGuard', () => {
	// 工作区根：path.resolve 在 Windows 给 C:\tmp\yunxiao-ws，POSIX 给 /tmp/yunxiao-ws
	const WS = path.resolve('/tmp/yunxiao-ws');
	const noSymlink: PathGuardOptions = { followSymlinks: false };

	describe('traversal protection', () => {
		it('rejects relative traversal escape', async () => {
			// Arrange / Act / Assert
			await assert.rejects(
				() => resolveWithinRoots('../../../etc/passwd', [WS], noSymlink),
				(err: unknown) => err instanceof PathGuardError && err.kind === 'traversal'
			);
		});

		it('rejects absolute path outside workspace', async () => {
			// Arrange
			const outside = path.sep === '/' ? '/etc/passwd' : 'C:\\Windows\\System32\\drivers';
			// Act / Assert
			await assert.rejects(
				() => resolveWithinRoots(outside, [WS], noSymlink),
				(err: unknown) => err instanceof PathGuardError && err.kind === 'traversal'
			);
		});

		it('accepts traversal that stays inside workspace', async () => {
			// Arrange / Act
			const result = await resolveWithinRoots('src/../src/extension.ts', [WS], noSymlink);
			// Assert
			assert.ok(result.fsPath.endsWith(path.join('src', 'extension.ts')));
			assert.strictEqual(result.sensitive, false);
		});

		it('accepts absolute path inside workspace', async () => {
			// Arrange
			const inside = path.join(WS, 'src', 'file.ts');
			// Act
			const result = await resolveWithinRoots(inside, [WS], noSymlink);
			// Assert
			assert.strictEqual(result.fsPath, path.normalize(inside));
		});

		(path.sep === '\\' ? it : it.skip)('accepts backslash separators on Windows (Windows-only)', async () => {
			// 仅 Windows：反斜杠分隔符应被正确规范化
			const result = await resolveWithinRoots('subdir\\..\\src\\file.ts', [WS], noSymlink);
			assert.ok(result.fsPath.endsWith(path.join('src', 'file.ts')));
		});
	});

	describe('workspace roots', () => {
		it('rejects all operations when no workspace root is provided', async () => {
			// Arrange / Act / Assert
			await assert.rejects(
				() => resolveWithinRoots('any.txt', [], noSymlink),
				(err: unknown) => err instanceof PathGuardError && err.kind === 'no_workspace'
			);
		});

		it('matches the first containing root in a multi-root workspace', async () => {
			// Arrange
			const ws2 = path.resolve('/tmp/yunxiao-ws2');
			// Act
			const result = await resolveWithinRoots('a.txt', [WS, ws2], noSymlink);
			// Assert
			assert.strictEqual(result.root, path.normalize(WS));
		});
	});

	describe('symlink handling', () => {
		const linkPath = path.normalize(path.resolve(WS, 'link'));

		it('rejects a symlink whose target escapes the workspace', async () => {
			// Arrange
			const escRealpath = async (p: string): Promise<string> =>
				p === linkPath ? path.join(path.dirname(WS), 'escaped') : p;
			// Act / Assert
			await assert.rejects(
				() => resolveWithinRoots('link', [WS], { followSymlinks: true, realpath: escRealpath }),
				(err: unknown) => err instanceof PathGuardError && err.kind === 'symlink_escape'
			);
		});

		it('accepts a symlink whose target stays inside the workspace', async () => {
			// Arrange
			const safeRealpath = async (p: string): Promise<string> =>
				p === linkPath ? path.join(WS, 'target') : p;
			// Act
			const result = await resolveWithinRoots('link', [WS], {
				followSymlinks: true,
				realpath: safeRealpath,
			});
			// Assert
			assert.strictEqual(result.fsPath, path.join(WS, 'target'));
		});
	});

	describe('sensitive file detection', () => {
		it('flags .env as sensitive', () => {
			assert.strictEqual(isSensitivePath('.env'), true);
			assert.strictEqual(isSensitivePath(path.join('config', '.env.production')), true);
		});

		it('flags .git paths as sensitive', () => {
			assert.strictEqual(isSensitivePath('.git/config'), true);
			assert.strictEqual(isSensitivePath(path.join(WS, '.git', 'HEAD')), true);
		});

		it('does not flag regular source files', () => {
			assert.strictEqual(isSensitivePath('src/extension.ts'), false);
		});

		it('marks resolved sensitive path with sensitive=true', async () => {
			const result = await resolveWithinRoots('.env', [WS], noSymlink);
			assert.strictEqual(result.sensitive, true);
		});
	});
});
