/**
 * SyncConfig 测试 - 覆盖配置来源私有存储：默认 claude、三值互斥、非法值回退。
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	DEFAULT_SKILL_DIRECTORIES,
	DEFAULT_SYNC_SOURCE,
	getSkillDirectories,
	getSyncSource,
	setSkillDirectories,
	setSyncSource,
} from '../../config/syncConfig';

/** 内存版 globalState（vscode.Memento 兼容形状）。 */
function createMemoryMemento() {
	const data = new Map<string, unknown>();
	return {
		get: <T>(key: string, def?: T): T | undefined =>
			data.has(key) ? (data.get(key) as T) : def,
		update: async (key: string, value: unknown): Promise<void> => {
			if (value === undefined) {
				data.delete(key);
			} else {
				data.set(key, value);
			}
		},
		keys: (): readonly string[] => [...data.keys()],
	};
}

describe('SyncConfig', () => {
	it('未保存时默认配置来源为 claude', () => {
		const globalState = createMemoryMemento();
		assert.strictEqual(DEFAULT_SYNC_SOURCE, 'claude');
		assert.strictEqual(getSyncSource(globalState as unknown as vscode.Memento), 'claude');
	});

	it('保存后可读取 none / claude / trae 三值', () => {
		for (const source of ['none', 'claude', 'trae'] as const) {
			const globalState = createMemoryMemento();
			const effective = setSyncSource(globalState as unknown as vscode.Memento, source);
			assert.strictEqual(effective, source);
			assert.strictEqual(getSyncSource(globalState as unknown as vscode.Memento), source);
		}
	});

	it('存储中的非法值回退默认 claude', () => {
		const globalState = createMemoryMemento();
		void globalState.update('yunxiaoAgent.syncSource', 'invalid');
		assert.strictEqual(getSyncSource(globalState as unknown as vscode.Memento), 'claude');
	});

	it('setSyncSource 拒绝非法值并保持既有配置', () => {
		const globalState = createMemoryMemento();
		setSyncSource(globalState as unknown as vscode.Memento, 'trae');
		const effective = setSyncSource(globalState as unknown as vscode.Memento, 'hack' as 'trae');
		assert.strictEqual(effective, 'trae', '非法输入应返回既有生效值');
		assert.strictEqual(getSyncSource(globalState as unknown as vscode.Memento), 'trae');
	});

	it('Skill 目录默认使用 .vscode/skills，并忽略绝对和越级路径', () => {
		const globalState = createMemoryMemento();
		assert.deepStrictEqual(DEFAULT_SKILL_DIRECTORIES, ['.vscode/skills']);
		assert.deepStrictEqual(getSkillDirectories(globalState as unknown as vscode.Memento), ['.vscode/skills']);

		const effective = setSkillDirectories(
			globalState as unknown as vscode.Memento,
			['.claude/skills', '.claude/skills', '', '..\\outside', 'C:\\outside']
		);
		assert.deepStrictEqual(effective, ['.claude/skills']);
		assert.deepStrictEqual(getSkillDirectories(globalState as unknown as vscode.Memento), ['.claude/skills']);
	});
});
