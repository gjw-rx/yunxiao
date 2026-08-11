/**
 * toolAdapter 测试 - 验证 ToolSchema → LLM ToolDefinition 与 → AI SDK tool 定义转换。
 *
 * 覆盖（Task 3.1 / 3.4）：
 * 1. ToolSchema → ToolDefinition 保留名称/描述/JSON Schema 参数
 * 2. ToolSchema → AI SDK tool 定义保留 name/description/inputSchema
 * 3. AI SDK tool 定义绝不注册 execute 回调（本地执行只经 ToolRouter）
 * 4. 空列表转换不抛错
 */
import * as assert from 'assert';
import {
	toolSchemaToDefinition,
	toolSchemasToDefinitions,
	toolSchemaToAiSdkTool,
	toolSchemasToAiSdkTools,
} from '../../agent/toolAdapter';
import type { ToolSchema } from '../../core/types';
import type { Tool } from 'ai';

const READ_SCHEMA: ToolSchema = {
	name: 'fs_read_file',
	description: '读取文件内容',
	parameters: {
		type: 'object',
		properties: { path: { type: 'string' } },
		required: ['path'],
	},
	permissions: 'read',
	canParallel: true,
};

const WRITE_SCHEMA: ToolSchema = {
	name: 'fs_write_file',
	description: '写入文件',
	parameters: {
		type: 'object',
		properties: { path: { type: 'string' }, content: { type: 'string' } },
		required: ['path', 'content'],
	},
	permissions: 'write',
};

describe('toolSchemaToDefinition', () => {
	it('保留名称、描述与 JSON Schema 参数', () => {
		const def = toolSchemaToDefinition(READ_SCHEMA);
		assert.strictEqual(def.name, 'fs_read_file');
		assert.strictEqual(def.description, '读取文件内容');
		assert.strictEqual(def.parameters, READ_SCHEMA.parameters);
	});

	it('批量转换数量一致', () => {
		const defs = toolSchemasToDefinitions([READ_SCHEMA, WRITE_SCHEMA]);
		assert.strictEqual(defs.length, 2);
		assert.strictEqual(defs[0].name, 'fs_read_file');
		assert.strictEqual(defs[1].name, 'fs_write_file');
	});

	it('空列表返回空数组', () => {
		assert.deepStrictEqual(toolSchemasToDefinitions([]), []);
	});
});

describe('toolSchemasToAiSdkTools', () => {
	it('转换为 AI SDK 工具定义表（name → Tool）', () => {
		const tools = toolSchemasToAiSdkTools([READ_SCHEMA, WRITE_SCHEMA]);
		assert.ok('fs_read_file' in tools);
		assert.ok('fs_write_file' in tools);
		const t = tools['fs_read_file'] as Tool;
		assert.strictEqual(t.description, '读取文件内容');
		// inputSchema 为 jsonSchema 包装，携带注册的 JSON Schema
		assert.ok(t.inputSchema, '应携带 inputSchema');
		assert.strictEqual(
			(t.inputSchema as unknown as { jsonSchema: unknown }).jsonSchema,
			READ_SCHEMA.parameters,
		);
	});

	it('禁止注册 execute 回调（本地执行只经 ToolRouter）', () => {
		const tools = toolSchemasToAiSdkTools([READ_SCHEMA, WRITE_SCHEMA]);
		for (const name of Object.keys(tools)) {
			const t = tools[name] as Tool;
			assert.strictEqual(
				(t as { execute?: unknown }).execute,
				undefined,
				`工具 ${name} 不应注册 AI SDK execute 回调`,
			);
			assert.strictEqual(
				(t as { onInputAvailable?: unknown }).onInputAvailable,
				undefined,
				`工具 ${name} 不应注册 onInputAvailable 回调`,
			);
		}
	});

	it('单个 schema 转换不注册 execute', () => {
		const t = toolSchemaToAiSdkTool(WRITE_SCHEMA);
		assert.strictEqual((t as { execute?: unknown }).execute, undefined);
		assert.strictEqual(t.description, '写入文件');
	});

	it('空列表返回空表', () => {
		assert.deepStrictEqual(toolSchemasToAiSdkTools([]), {});
	});
});
