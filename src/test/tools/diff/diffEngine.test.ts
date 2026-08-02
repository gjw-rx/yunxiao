import * as assert from 'assert';
import { parseDiff, applyDiff, createDiff } from '../../../tools/diff/diffEngine';

describe('diffEngine', () => {
	const original = 'line1\nline2\nline3\nline4\n';
	const modified = 'line1\nline2-changed\nline3\nline4\n';

	it('createDiff 生成可被 parseDiff 解析的 unified diff', () => {
		// Act
		const diff = createDiff(original, modified, 'f.txt');
		const parsed = parseDiff(diff);
		// Assert
		assert.ok(diff.includes('@@'));
		assert.ok(diff.includes('-line2'));
		assert.ok(diff.includes('+line2-changed'));
		assert.strictEqual(parsed.length, 1);
		assert.strictEqual(parsed[0].hunks.length, 1);
	});

	it('parseDiff 拒绝非法/空输入', () => {
		// Arrange / Act / Assert
		assert.throws(() => parseDiff(''), /无法解析/);
		assert.throws(() => parseDiff('not a diff at all'), /无法解析/);
	});

	it('applyDiff 应用匹配的 patch 成功', () => {
		// Arrange
		const diff = createDiff(original, modified, 'f.txt');
		// Act
		const result = applyDiff(original, diff);
		// Assert
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.result, modified);
		assert.strictEqual(result.conflict, undefined);
	});

	it('applyDiff 上下文漂移返回冲突，原内容不变', () => {
		// Arrange
		const diff = createDiff(original, modified, 'f.txt');
		const drifted = 'totally\ndifferent\ncontent\nhere\n';
		// Act
		const result = applyDiff(drifted, diff);
		// Assert
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.result, drifted); // 原内容不变
		assert.ok(result.conflict?.includes('上下文不匹配'));
	});

	it('applyDiff 接受 ParsedPatch 对象输入', () => {
		// Arrange
		const diff = createDiff(original, modified, 'f.txt');
		const parsed = parseDiff(diff);
		// Act
		const result = applyDiff(original, parsed[0]);
		// Assert
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.result, modified);
	});

	it('createDiff 往返：生成 -> 解析 -> 应用 还原为 modified', () => {
		// Act
		const diff = createDiff(original, modified);
		const result = applyDiff(original, diff);
		// Assert
		assert.strictEqual(result.result, modified);
	});

	it('applyDiff 空白变化可被 fuzz 容忍', () => {
		// Arrange：原内容末尾无换行，patch 基于有换行版本生成
		const orig = 'a\nb\nc';
		const mod = 'a\nB\nc';
		const diff = createDiff('a\nb\nc\n', 'a\nB\nc\n', 'f.txt');
		// Act
		const result = applyDiff(orig, diff);
		// Assert
		assert.strictEqual(result.ok, true);
	});
});
