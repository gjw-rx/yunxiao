/**
 * 对话输入与滚动行为测试。
 *
 * 职责：锁定 Slash 命令在任意输入位置的触发规则，以及仅在用户位于底部时自动跟随的规则。
 */
import { describe, expect, it } from 'vitest';
import { findSlashCommandToken, isNearScrollBottom } from '../utils/chatBehavior';

describe('findSlashCommandToken', () => {
	/** 光标位于消息中部的命令片段时仍可识别。 */
	it('识别消息中间的 Slash 命令并保留完整替换范围', () => {
		expect(findSlashCommandToken('请使用 /review 检查这段代码', 11)).toEqual({ query: 'review', start: 4, end: 11 });
	});

	/** 非命令路径不应打开命令菜单。 */
	it('忽略嵌在普通文本中的斜杠', () => {
		expect(findSlashCommandToken('访问 foo/bar', 10)).toBeNull();
	});

	/** 换行后的命令与开头命令同样有效。 */
	it('识别换行后的 Slash 命令', () => {
		expect(findSlashCommandToken('先分析\n/plan 后实施', 9)).toEqual({ query: 'plan', start: 4, end: 9 });
	});
});

describe('isNearScrollBottom', () => {
	/** 精确处于底部时应保持跟随。 */
	it('在底部时返回 true', () => {
		expect(isNearScrollBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
	});

	/** 用户上滚时不应被流式输出强制拉回。 */
	it('明显离开底部时返回 false', () => {
		expect(isNearScrollBottom({ scrollTop: 520, clientHeight: 400, scrollHeight: 1000 })).toBe(false);
	});
});
