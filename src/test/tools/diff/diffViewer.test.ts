import * as assert from 'assert';
import { DiffViewer, type VsCodeShim } from '../../../tools/diff/diffViewer';

describe('DiffViewer', () => {
	it('调用 vscode.diff 命令并传入两侧 Uri 与标题', async () => {
		// Arrange
		const calls: { command: string; args: unknown[] }[] = [];
		const uris: string[] = [];
		const shim: VsCodeShim = {
			executeCommand(command, ...args) {
				calls.push({ command, args });
				return Promise.resolve(undefined);
			},
			fileUri(fsPath) {
				uris.push(fsPath);
				return { fsPath };
			},
		};
		const viewer = new DiffViewer(shim);
		// Act
		await viewer.showDiff('/a/original.txt', '/b/proposed.txt', 'code.edit: x');
		// Assert
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].command, 'vscode.diff');
		assert.strictEqual(calls[0].args.length, 3);
		assert.deepStrictEqual(calls[0].args[2], 'code.edit: x');
		assert.deepStrictEqual(uris, ['/a/original.txt', '/b/proposed.txt']);
	});
});
