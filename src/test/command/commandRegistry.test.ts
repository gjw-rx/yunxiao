/**
 * Command 注册表测试 - 覆盖项目同名覆盖全局、删除项目项恢复全局、物理快照保留。
 */
import * as assert from 'assert';
import { CommandRegistry } from '../../command/commandRegistry';
import type { Command, CommandSnapshot } from '../../command/types';

/** 构造单条 Command。 @param name 名称。 @param scope 作用域。 @returns Command。 */
function makeCommand(name: string, scope: 'global' | 'project', body: string): Command {
	return {
		name,
		scope,
		body,
		sourcePath: `/ws/${scope}/${name}.md`,
	};
}

/** 构造双作用域快照。 @param global 全局命令。 @param project 项目命令（可空）。 @returns 快照。 */
function makeSnapshot(global: Command[], project?: Command[]): CommandSnapshot {
	return {
		global: { scope: 'global', directory: '/ws/global', commands: global },
		project: project ? { scope: 'project', directory: '/ws/project', commands: project } : null,
	};
}

describe('CommandRegistry', () => {
	it('reload 后 list 返回合并去重结果（按名称排序）', () => {
		const registry = new CommandRegistry();
		registry.reload(
			makeSnapshot(
				[makeCommand('b', 'global', 'gb'), makeCommand('a', 'global', 'ga')],
				[makeCommand('c', 'project', 'pc')],
			),
		);
		assert.deepStrictEqual(
			registry.list().map((c) => c.name),
			['a', 'b', 'c'],
		);
	});

	it('项目同名命令覆盖全局命令（描述与正文取项目）', () => {
		const registry = new CommandRegistry();
		registry.reload(
			makeSnapshot(
				[makeCommand('review', 'global', '全局正文')],
				[{ ...makeCommand('review', 'project', '项目正文'), description: '项目描述' }],
			),
		);
		const effective = registry.get('review');
		assert.ok(effective);
		assert.strictEqual(effective?.body, '项目正文');
		assert.strictEqual(effective?.description, '项目描述');
		assert.strictEqual(effective?.scope, 'project');
		assert.strictEqual(registry.isOverridden('review'), true);
	});

	it('物理快照保留被覆盖的全局项（listGlobal 仍可见）', () => {
		const registry = new CommandRegistry();
		registry.reload(
			makeSnapshot(
				[makeCommand('review', 'global', '全局正文')],
				[makeCommand('review', 'project', '项目正文')],
			),
		);
		assert.strictEqual(registry.listGlobal().length, 1);
		assert.strictEqual(registry.listGlobal()[0].body, '全局正文');
		assert.strictEqual(registry.listProject().length, 1);
	});

	it('删除项目覆盖项后重新 reload，恢复全局项生效', () => {
		const registry = new CommandRegistry();
		registry.reload(
			makeSnapshot(
				[makeCommand('review', 'global', '全局正文')],
				[makeCommand('review', 'project', '项目正文')],
			),
		);
		assert.strictEqual(registry.get('review')?.body, '项目正文');
		// 模拟删除项目项后 reload
		registry.reload(makeSnapshot([makeCommand('review', 'global', '全局正文')], []));
		const effective = registry.get('review');
		assert.strictEqual(effective?.body, '全局正文');
		assert.strictEqual(registry.isOverridden('review'), false);
	});

	it('getEffective 返回覆盖状态', () => {
		const registry = new CommandRegistry();
		registry.reload(
			makeSnapshot(
				[makeCommand('both', 'global', 'g'), makeCommand('only-g', 'global', 'g')],
				[makeCommand('both', 'project', 'p')],
			),
		);
		assert.strictEqual(registry.getEffective('both')?.overridden, true);
		assert.strictEqual(registry.getEffective('only-g')?.overridden, false);
		assert.strictEqual(registry.getEffective('missing'), undefined);
	});

	it('getScope 返回命令所属物理作用域', () => {
		const registry = new CommandRegistry();
		registry.reload(
			makeSnapshot(
				[makeCommand('both', 'global', 'g'), makeCommand('only-g', 'global', 'g')],
				[makeCommand('both', 'project', 'p'), makeCommand('only-p', 'project', 'p')],
			),
		);
		assert.strictEqual(registry.getScope('both'), 'project');
		assert.strictEqual(registry.getScope('only-g'), 'global');
		assert.strictEqual(registry.getScope('only-p'), 'project');
		assert.strictEqual(registry.getScope('missing'), undefined);
	});

	it('目录 getter 返回加载时快照的目录', () => {
		const registry = new CommandRegistry();
		registry.reload(makeSnapshot([makeCommand('a', 'global', 'g')], [makeCommand('b', 'project', 'p')]));
		assert.strictEqual(registry.getGlobalDirectory(), '/ws/global');
		assert.strictEqual(registry.getProjectDirectory(), '/ws/project');
	});
});
