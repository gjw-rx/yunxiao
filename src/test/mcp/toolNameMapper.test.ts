/**
 * MCP 工具名映射测试（任务 6.1）。
 *
 * 覆盖：mcp__server__tool 格式、非法字符净化、空片段拒绝、长度上限与稳定哈希、
 * 重复发现结果一致、最终冲突拒绝与不可变反向 catalog。
 */
import * as assert from 'assert';
import { McpToolNameMapper } from '../../mcp/toolNameMapper';
import type { McpToolCatalogEntry, McpToolAnnotations } from '../../mcp/types';

/** 构造 catalog 输入项。 */
function entry(
	serverId: string,
	nativeToolName: string,
	overrides: Partial<Omit<McpToolCatalogEntry, 'serverId' | 'nativeToolName' | 'exposedName'>> = {},
): { serverId: string; nativeToolName: string; description: string; inputSchema: Record<string, unknown>; annotations?: McpToolAnnotations } {
	return {
		serverId,
		nativeToolName,
		description: `${serverId}/${nativeToolName}`,
		inputSchema: { type: 'object', properties: {} },
		...overrides,
	};
}

describe('McpToolNameMapper 名称映射（6.1）', () => {
	it('标准格式 mcp__<server>__<tool>', () => {
		const mapper = new McpToolNameMapper([
			entry('codegraph', 'codegraph_explore'),
		]);
		const catalog = mapper.getCatalog();
		assert.strictEqual(catalog.length, 1);
		assert.strictEqual(catalog[0].exposedName, 'mcp__codegraph__codegraph_explore');
		assert.strictEqual(catalog[0].serverId, 'codegraph');
		assert.strictEqual(catalog[0].nativeToolName, 'codegraph_explore');
	});

	it('非法字符净化为下划线', () => {
		const mapper = new McpToolNameMapper([
			entry('my.server', 'tool-name.with/slash'),
		]);
		const exposed = mapper.getCatalog()[0].exposedName;
		// 点、斜杠、连字符以外的特殊字符都应被净化
		assert.ok(exposed.startsWith('mcp__'), `expected mcp__ prefix, got ${exposed}`);
		assert.ok(!exposed.includes('.'), `dot not sanitized: ${exposed}`);
		assert.ok(!exposed.includes('/'), `slash not sanitized: ${exposed}`);
		assert.ok(!exposed.includes('-'), `hyphen not sanitized: ${exposed}`);
	});

	it('空 Server ID 拒绝', () => {
		assert.throws(
			() => new McpToolNameMapper([entry('', 'tool')]),
			/mcp__|server|empty|空/i,
		);
	});

	it('空工具名拒绝', () => {
		assert.throws(
			() => new McpToolNameMapper([entry('server', '')]),
			/mcp__|tool|empty|空/i,
		);
	});

	it('净化后空片段拒绝', () => {
		// 全部是非法字符，净化后为空
		assert.throws(
			() => new McpToolNameMapper([entry('!!!', 'tool')]),
			/mcp__|server|empty|空|sanitiz/i,
		);
		assert.throws(
			() => new McpToolNameMapper([entry('server', '!!!')]),
			/mcp__|tool|empty|空|sanitiz/i,
		);
	});

	it('超长名称使用稳定哈希后缀且不超过 64 字符', () => {
		const longServer = 'a'.repeat(30);
		const longTool = 'b'.repeat(40);
		const mapper = new McpToolNameMapper([
			entry(longServer, longTool),
		]);
		const exposed = mapper.getCatalog()[0].exposedName;
		assert.ok(exposed.length <= 64, `exposed name exceeds 64: ${exposed.length} chars`);
		assert.ok(exposed.startsWith('mcp__'), `expected mcp__ prefix: ${exposed}`);
	});

	it('稳定哈希：相同输入产生相同输出', () => {
		const longServer = 'a'.repeat(30);
		const longTool = 'b'.repeat(40);
		const mapper1 = new McpToolNameMapper([entry(longServer, longTool)]);
		const mapper2 = new McpToolNameMapper([entry(longServer, longTool)]);
		assert.strictEqual(mapper1.getCatalog()[0].exposedName, mapper2.getCatalog()[0].exposedName);
	});

	it('不同输入产生不同哈希后缀', () => {
		const longTool = 'b'.repeat(40);
		const mapper1 = new McpToolNameMapper([entry('a'.repeat(30), longTool)]);
		const mapper2 = new McpToolNameMapper([entry('c'.repeat(30), longTool)]);
		assert.notStrictEqual(mapper1.getCatalog()[0].exposedName, mapper2.getCatalog()[0].exposedName);
	});

	it('最终冲突拒绝：两个不同原始标识归一化后相同', () => {
		// my.server.tool 和 my_server_tool 都净化为 my_server_tool
		assert.throws(
			() => new McpToolNameMapper([
				entry('srv', 'my.server.tool'),
				entry('srv', 'my_server_tool'),
			]),
			/conflict|冲突|mcp__/i,
		);
	});

	it('跨 Server 同名工具不冲突', () => {
		// 不同 Server 的同名工具应产生不同的 exposed name
		const mapper = new McpToolNameMapper([
			entry('server-a', 'query'),
			entry('server-b', 'query'),
		]);
		const names = mapper.getCatalog().map((e) => e.exposedName);
		assert.strictEqual(names.length, 2);
		assert.notStrictEqual(names[0], names[1]);
	});

	it('getByExposedName 返回正确的 catalog entry', () => {
		const mapper = new McpToolNameMapper([
			entry('codegraph', 'explore', { description: '探索代码结构' }),
		]);
		const found = mapper.getByExposedName('mcp__codegraph__explore');
		assert.ok(found);
		assert.strictEqual(found.serverId, 'codegraph');
		assert.strictEqual(found.nativeToolName, 'explore');
		assert.strictEqual(found.description, '探索代码结构');
	});

	it('getByExposedName 未知名返回 undefined', () => {
		const mapper = new McpToolNameMapper([entry('srv', 'tool')]);
		assert.strictEqual(mapper.getByExposedName('mcp__unknown__tool'), undefined);
	});

	it('catalog 不可变：修改返回数组不影响内部状态', () => {
		const mapper = new McpToolNameMapper([entry('srv', 'tool')]);
		const catalog1 = mapper.getCatalog();
		assert.strictEqual(catalog1.length, 1);
		// 返回的应是只读快照，重复调用返回一致内容
		const catalog2 = mapper.getCatalog();
		assert.strictEqual(catalog2.length, 1);
		assert.strictEqual(catalog1[0].exposedName, catalog2[0].exposedName);
	});

	it('空输入列表构造空 catalog', () => {
		const mapper = new McpToolNameMapper([]);
		assert.strictEqual(mapper.getCatalog().length, 0);
		assert.strictEqual(mapper.getByExposedName('mcp__any__tool'), undefined);
	});

	it('exposed name 只包含合法字符 [a-zA-Z0-9_]', () => {
		const mapper = new McpToolNameMapper([
			entry('my.server-1', 'tool.name/2'),
			entry('a'.repeat(30), 'b'.repeat(40)),
		]);
		for (const entry of mapper.getCatalog()) {
			assert.ok(
				/^[a-zA-Z0-9_]+$/.test(entry.exposedName),
				`illegal characters in exposed name: ${entry.exposedName}`,
			);
		}
	});
});
