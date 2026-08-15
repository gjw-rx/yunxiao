/**
 * MCP 工具 schema 转换与权限映射测试（任务 6.3/6.5）。
 *
 * 覆盖：description 来源与 Server 标识、inputSchema 原样复用、缺失 schema 严格回退、
 * JSON 可序列化；权限映射（destructive 优先/readOnly/execute）；并行策略
 * （明确只读且非 open-world 可并行，其余串行，Transport 不影响权限）。
 */
import * as assert from 'assert';
import { convertMcpToolToSchema } from '../../mcp/toolSchemaAdapter';
import type { McpToolCatalogEntry, McpToolAnnotations } from '../../mcp/types';
import type { ToolSchema } from '../../core/types';

/** 构造 catalog entry。 */
function makeEntry(overrides: Partial<McpToolCatalogEntry> = {}): McpToolCatalogEntry {
	return {
		serverId: 'codegraph',
		nativeToolName: 'codegraph_explore',
		exposedName: 'mcp__codegraph__codegraph_explore',
		description: '探索代码结构',
		inputSchema: {
			type: 'object',
			properties: { query: { type: 'string', description: '搜索关键词' } },
			required: ['query'],
		},
		...overrides,
	};
}

describe('MCP Tool schema 转换（6.3）', () => {
	it('description 来源 MCP 工具并标识来源 Server', () => {
		const schema = convertMcpToolToSchema(makeEntry());
		assert.ok(schema.description.includes('探索代码结构'), `description should contain original: "${schema.description}"`);
		assert.ok(schema.description.includes('codegraph'), `description should identify server: "${schema.description}"`);
	});

	it('inputSchema 原样复用为 parameters', () => {
		const inputSchema = {
			type: 'object',
			properties: { query: { type: 'string' } },
			required: ['query'],
		};
		const schema = convertMcpToolToSchema(makeEntry({ inputSchema }));
		assert.deepStrictEqual(schema.parameters, inputSchema);
	});

	it('保留 query 必填约束', () => {
		const schema = convertMcpToolToSchema(makeEntry());
		assert.ok(Array.isArray(schema.parameters.required));
		assert.ok(schema.parameters.required.includes('query'));
	});

	it('缺失 inputSchema 时使用禁止额外字段的空对象', () => {
		const entry = makeEntry({ inputSchema: {} });
		const schema = convertMcpToolToSchema(entry);
		assert.deepStrictEqual(schema.parameters, { type: 'object', properties: {}, additionalProperties: false });
	});

	it('inputSchema 为空对象时严格回退', () => {
		const entry = makeEntry({ inputSchema: {} });
		const schema = convertMcpToolToSchema(entry);
		// 空对象 → 严格空 schema（不接受任意输入）
		assert.strictEqual(schema.parameters.additionalProperties, false);
	});

	it('schema JSON 可序列化', () => {
		const schema = convertMcpToolToSchema(makeEntry());
		const json = JSON.stringify(schema);
		const parsed = JSON.parse(json) as ToolSchema;
		assert.strictEqual(parsed.name, schema.name);
		assert.strictEqual(parsed.description, schema.description);
		assert.deepStrictEqual(parsed.parameters, schema.parameters);
		assert.strictEqual(parsed.permissions, schema.permissions);
	});

	it('exposed name 作为 schema.name', () => {
		const entry = makeEntry({ exposedName: 'mcp__custom__tool' });
		const schema = convertMcpToolToSchema(entry);
		assert.strictEqual(schema.name, 'mcp__custom__tool');
	});
});

describe('MCP 权限映射（6.4）', () => {
	it('destructiveHint true → destructive', () => {
		const annotations: McpToolAnnotations = { destructiveHint: true };
		const schema = convertMcpToolToSchema(makeEntry({ annotations }));
		assert.strictEqual(schema.permissions, 'destructive');
	});

	it('readOnlyHint true（无 destructive）→ read', () => {
		const annotations: McpToolAnnotations = { readOnlyHint: true };
		const schema = convertMcpToolToSchema(makeEntry({ annotations }));
		assert.strictEqual(schema.permissions, 'read');
	});

	it('无 annotations → execute', () => {
		const schema = convertMcpToolToSchema(makeEntry({ annotations: undefined }));
		assert.strictEqual(schema.permissions, 'execute');
	});

	it('destructive 优先于 readOnly', () => {
		const annotations: McpToolAnnotations = { readOnlyHint: true, destructiveHint: true };
		const schema = convertMcpToolToSchema(makeEntry({ annotations }));
		assert.strictEqual(schema.permissions, 'destructive');
	});

	it('openWorldHint true 不影响权限（仍 read）', () => {
		const annotations: McpToolAnnotations = { readOnlyHint: true, openWorldHint: true };
		const schema = convertMcpToolToSchema(makeEntry({ annotations }));
		assert.strictEqual(schema.permissions, 'read');
	});
});

describe('MCP 并行策略 canParallel（6.5/6.6）', () => {
	it('明确只读且非 open-world → canParallel true', () => {
		const annotations: McpToolAnnotations = { readOnlyHint: true, openWorldHint: false };
		const schema = convertMcpToolToSchema(makeEntry({ annotations }));
		assert.strictEqual(schema.canParallel, true);
	});

	it('只读但 open-world → canParallel false', () => {
		const annotations: McpToolAnnotations = { readOnlyHint: true, openWorldHint: true };
		const schema = convertMcpToolToSchema(makeEntry({ annotations }));
		assert.strictEqual(schema.canParallel, false);
	});

	it('只读但未声明 openWorld → canParallel true（缺省非 open-world）', () => {
		const annotations: McpToolAnnotations = { readOnlyHint: true };
		const schema = convertMcpToolToSchema(makeEntry({ annotations }));
		assert.strictEqual(schema.canParallel, true);
	});

	it('destructive → canParallel false', () => {
		const annotations: McpToolAnnotations = { destructiveHint: true };
		const schema = convertMcpToolToSchema(makeEntry({ annotations }));
		assert.strictEqual(schema.canParallel, false);
	});

	it('无 annotations → canParallel false', () => {
		const schema = convertMcpToolToSchema(makeEntry({ annotations: undefined }));
		assert.strictEqual(schema.canParallel, false);
	});

	it('Transport 不影响权限：STDIO 与远程工具权限规则一致', () => {
		// 权限只由 annotations 决定，与 Transport 无关
		const stdioAnnotations: McpToolAnnotations = { readOnlyHint: true, openWorldHint: false };
		const remoteAnnotations: McpToolAnnotations = { readOnlyHint: true, openWorldHint: false };
		const stdioSchema = convertMcpToolToSchema(makeEntry({
			serverId: 'stdio-srv',
			annotations: stdioAnnotations,
		}));
		const remoteSchema = convertMcpToolToSchema(makeEntry({
			serverId: 'remote-srv',
			annotations: remoteAnnotations,
		}));
		assert.strictEqual(stdioSchema.permissions, remoteSchema.permissions);
		assert.strictEqual(stdioSchema.canParallel, remoteSchema.canParallel);
	});
});
