/**
 * ToolExposurePolicy 单元测试。
 * 验证职责型本地工具的映射、参数边界与暴露策略：
 * - 普通模式固定 13 个职责型工具，隐藏底层专用 schema
 * - Plan 只读子集 / executing 恢复完整集合
 * - MCP 全量直出与 Plan read 过滤
 * - 未映射/未知本地工具默认不暴露
 */
import * as assert from 'assert';
import {
	RESPONSIBILITY_TOOL_DEFS,
	RESPONSIBILITY_NAMES,
	buildRunToolSnapshot,
	resolveResponsibilityCall,
	snapshotAllSchemas,
	type RunToolSnapshot,
} from '../../agent/toolExposurePolicy';
import type { ToolSchema } from '../../core/types';

/** 构造本地静态工具 schema（模拟隐藏实现）。 */
function localSchema(name: string, permissions: 'read' | 'write' | 'execute' | 'destructive'): ToolSchema {
	return { name, description: `${name} 隐藏实现`, parameters: { type: 'object', properties: {} }, permissions };
}

/** 构造 MCP 工具 schema。 */
function mcpSchema(name: string, permissions: 'read' | 'write' | 'execute' | 'destructive'): ToolSchema {
	return {
		name,
		description: `[MCP/foo] ${name}`,
		parameters: { type: 'object', properties: {} },
		permissions,
		// 与真实 MCP 转换器一致：仅 read 且非 open-world 时可并行
		canParallel: permissions === 'read',
	};
}

/** 模拟完整本地 Registry 快照（含 21 个隐藏实现与职责型工具）。 */
function localRegistrySchemas(): ToolSchema[] {
	const hidden = [
		'fs_read_file',
		'fs_write_file',
		'fs_list_dir',
		'fs_search_files',
		'fs_delete_file',
		'fs_move_file',
		'code_edit',
		'code_get_diagnostics',
		'code_workspace_symbols',
		'code_find_references',
		'code_go_to_definition',
		'web_search',
		'terminal_exec',
		'git_status',
		'git_log',
		'git_diff',
		'git_commit',
		'git_branch',
		'git_stash',
		'todo_write',
		'skill',
	].map((n) => localSchema(n, 'read'));
	return hidden;
}

/** 固定 13 个职责型工具名。 */
const ALL_RESPONSIBILITY = new Set([
	'bash', 'read', 'glob', 'grep', 'edit', 'write', 'apply_patch', 'task',
	'webfetch', 'websearch', 'todowrite', 'skill', 'question',
]);

describe('ToolExposurePolicy 职责型工具定义', () => {
	it('恰好定义 13 个职责型工具且 schema 名唯一', () => {
		assert.strictEqual(RESPONSIBILITY_TOOL_DEFS.length, 13);
		const names = RESPONSIBILITY_TOOL_DEFS.map((d) => d.name);
		assert.strictEqual(new Set(names).size, 13);
	});

	it('每个职责型 schema 的名称与定义名一致', () => {
		for (const def of RESPONSIBILITY_TOOL_DEFS) {
			assert.strictEqual(def.schema.name, def.name);
			assert.ok(def.schema.description.length > 0);
		}
	});

	it('RESPONSIBILITY_NAMES 包含全部 13 个名称', () => {
		assert.strictEqual(RESPONSIBILITY_NAMES.size, 13);
		assert.deepStrictEqual(new Set([...RESPONSIBILITY_NAMES]), ALL_RESPONSIBILITY);
	});
});

describe('ToolExposurePolicy resolveResponsibilityCall 映射', () => {
	it('read 文件模式映射到 fs_read_file', () => {
		const r = resolveResponsibilityCall('read', { path: 'a.ts', offset: 10 });
		assert.strictEqual(r?.kind, 'mapped');
		if (r?.kind === 'mapped') {
			assert.strictEqual(r.tool, 'fs_read_file');
			assert.strictEqual(r.args.path, 'a.ts');
			assert.strictEqual(r.args.offset, 10);
		}
	});

	it('read 目录模式映射到 fs_list_dir', () => {
		const r = resolveResponsibilityCall('read', { path: 'src', type: 'dir', recursive: true });
		assert.strictEqual(r?.kind, 'mapped');
		if (r?.kind === 'mapped') {
			assert.strictEqual(r.tool, 'fs_list_dir');
			assert.strictEqual(r.args.recursive, true);
		}
	});

	it('edit 映射到 code_edit，write 映射到 fs_write_file', () => {
		const edit = resolveResponsibilityCall('edit', { path: 'a.ts', oldString: 'x', newString: 'y' });
		assert.deepStrictEqual(edit, { kind: 'mapped', tool: 'code_edit', args: { path: 'a.ts', oldString: 'x', newString: 'y' } });
		const write = resolveResponsibilityCall('write', { path: 'b.ts', content: 'c' });
		assert.deepStrictEqual(write, { kind: 'mapped', tool: 'fs_write_file', args: { path: 'b.ts', content: 'c' } });
	});

	it('apply_patch 映射到 code_edit 并透传 patch', () => {
		const r = resolveResponsibilityCall('apply_patch', { path: 'a.ts', patch: '--- a\n+++ b\n@@' });
		assert.deepStrictEqual(r, { kind: 'mapped', tool: 'code_edit', args: { path: 'a.ts', patch: '--- a\n+++ b\n@@' } });
	});

	it('bash 映射到 terminal_exec（参数透传）', () => {
		const r = resolveResponsibilityCall('bash', { command: 'npm test', cwd: 'pkg' });
		assert.deepStrictEqual(r, { kind: 'mapped', tool: 'terminal_exec', args: { command: 'npm test', cwd: 'pkg' } });
	});

	it('grep 映射到 fs_search_files regex，glob 映射到 glob', () => {
		const grep = resolveResponsibilityCall('grep', { pattern: 'foo', contextLines: 3 });
		assert.deepStrictEqual(grep, { kind: 'mapped', tool: 'fs_search_files', args: { pattern: 'foo', mode: 'regex', contextLines: 3 } });
		const glob = resolveResponsibilityCall('glob', { pattern: '**/*.ts' });
		assert.deepStrictEqual(glob, { kind: 'mapped', tool: 'fs_search_files', args: { pattern: '**/*.ts', mode: 'glob' } });
	});

	it('websearch/todowrite/skill 分别映射到 web_search/todo_write/skill', () => {
		assert.strictEqual(resolveResponsibilityCall('websearch', { query: 't' })?.kind, 'mapped');
		assert.strictEqual((resolveResponsibilityCall('websearch', { query: 't' }) as { tool: string }).tool, 'web_search');
		assert.strictEqual((resolveResponsibilityCall('todowrite', { todos: [] }) as { tool: string }).tool, 'todo_write');
		assert.strictEqual((resolveResponsibilityCall('skill', { name: 'x' }) as { tool: string }).tool, 'skill');
	});

	it('webfetch/task/question 为 virtual（无底层实现）', () => {
		assert.strictEqual(resolveResponsibilityCall('webfetch', { url: 'https://x.com' })?.kind, 'virtual');
		assert.strictEqual(resolveResponsibilityCall('task', { description: 'd' })?.kind, 'virtual');
		assert.strictEqual(resolveResponsibilityCall('question', { question: 'q' })?.kind, 'virtual');
	});

	it('未知本地工具名返回 null（不猜测映射）', () => {
		assert.strictEqual(resolveResponsibilityCall('fs_read_file', {}), null);
		assert.strictEqual(resolveResponsibilityCall('unknown_tool', {}), null);
	});
});

describe('ToolExposurePolicy buildRunToolSnapshot 暴露策略', () => {
	const localSchemas = localRegistrySchemas();
	const mcpSchemas = [mcpSchema('mcp__codegraph__explore', 'read'), mcpSchema('mcp__db__write', 'execute')];

	function exposedNames(snapshot: RunToolSnapshot): Set<string> {
		return new Set(snapshotAllSchemas(snapshot).map((s) => s.name));
	}

	it('普通模式暴露固定 13 个本地职责型 + 全部 ready MCP，隐藏 fs_*/code_*/git_* 专用 schema', () => {
		const snapshot = buildRunToolSnapshot(localSchemas, mcpSchemas, 'normal');
		const names = exposedNames(snapshot);
		// 13 个职责型工具全量
		assert.strictEqual(snapshot.localTools.length, 13);
		assert.deepStrictEqual(new Set(snapshot.localTools.map((s) => s.name)), ALL_RESPONSIBILITY);
		// 不包含任何隐藏实现名
		for (const hidden of ['fs_read_file', 'code_edit', 'git_status', 'terminal_exec', 'fs_delete_file']) {
			assert.ok(!names.has(hidden), `不应暴露隐藏实现 ${hidden}`);
		}
		// MCP 全量直出
		assert.deepStrictEqual(new Set(snapshot.mcpTools.map((s) => s.name)), new Set(['mcp__codegraph__explore', 'mcp__db__write']));
		// 计数
		assert.strictEqual(snapshot.exposedLocalCount, 13);
		assert.strictEqual(snapshot.registeredLocalCount, localSchemas.length);
		assert.strictEqual(snapshot.exposedMcpCount, 2);
	});

	it('planning/review 阶段仅暴露只读职责子集与 read MCP', () => {
		const snapshot = buildRunToolSnapshot(localSchemas, mcpSchemas, 'planning');
		const localNames = new Set(snapshot.localTools.map((s) => s.name));
		// 只读子集：read/glob/grep/webfetch/websearch/skill/question/todowrite
		for (const n of ['read', 'glob', 'grep', 'webfetch', 'websearch', 'skill', 'question', 'todowrite']) {
			assert.ok(localNames.has(n), `planning 应暴露 ${n}`);
		}
		// 写/执行类不出现
		for (const n of ['bash', 'edit', 'write', 'apply_patch', 'task']) {
			assert.ok(!localNames.has(n), `planning 不应暴露 ${n}`);
		}
		// MCP 仅保留 read 权限（execute 的 mcp__db__write 被过滤）
		assert.deepStrictEqual(new Set(snapshot.mcpTools.map((s) => s.name)), new Set(['mcp__codegraph__explore']));
		// review 与 planning 一致
		const review = buildRunToolSnapshot(localSchemas, mcpSchemas, 'review');
		assert.deepStrictEqual(new Set(review.localTools.map((s) => s.name)), localNames);
	});

	it('executing 阶段恢复完整 13 个本地职责型 + 全部 MCP', () => {
		const snapshot = buildRunToolSnapshot(localSchemas, mcpSchemas, 'executing');
		const names = exposedNames(snapshot);
		assert.deepStrictEqual(new Set(snapshot.localTools.map((s) => s.name)), ALL_RESPONSIBILITY);
		assert.deepStrictEqual(new Set(snapshot.mcpTools.map((s) => s.name)), new Set(['mcp__codegraph__explore', 'mcp__db__write']));
		assert.ok(names.has('bash') && names.has('edit'));
	});

	it('未显式映射的新本地工具不进入暴露集合（模型不可见）', () => {
		const schemas = [...localSchemas, localSchema('brand_new_tool', 'read')];
		const snapshot = buildRunToolSnapshot(schemas, [], 'normal');
		assert.ok(!exposedNames(snapshot).has('brand_new_tool'));
		assert.ok(!snapshot.exposedNames.has('brand_new_tool'));
	});

	it('parallelableNames 仅包含 canParallel 的职责型/MCP 工具', () => {
		const snapshot = buildRunToolSnapshot(localSchemas, mcpSchemas, 'normal');
		assert.ok(snapshot.parallelableNames.has('read'));
		assert.ok(snapshot.parallelableNames.has('grep'));
		assert.ok(!snapshot.parallelableNames.has('edit'));
		assert.ok(!snapshot.parallelableNames.has('bash'));
		assert.ok(snapshot.parallelableNames.has('mcp__codegraph__explore'));
		assert.ok(!snapshot.parallelableNames.has('mcp__db__write'));
	});
});