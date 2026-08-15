/**
 * MCP CallToolResult 归一化测试（任务 6.7/6.9）。
 *
 * 覆盖：text、structuredContent、text resource、resource link、多段顺序、空结果、
 * isError、未知类型；image/audio/blob 不内联 base64，仅返回安全描述与 metadata。
 */
import * as assert from 'assert';
import { normalizeCallToolResult } from '../../mcp/resultNormalizer';
import type { McpCallToolResult, McpContent } from '../../mcp/resultNormalizer';

/** 构造 text content。 */
function text(t: string): McpContent {
	return { type: 'text', text: t };
}

/** 构造 image content。 */
function image(mimeType: string, data: string): McpContent {
	return { type: 'image', mimeType, data };
}

/** 构造 audio content。 */
function audio(mimeType: string, data: string): McpContent {
	return { type: 'audio', mimeType, data };
}

/** 构造 text resource content（EmbeddedResource）。 */
function textResource(uri: string, text: string, mimeType?: string): McpContent {
	return { type: 'resource', resource: { uri, text, ...(mimeType ? { mimeType } : {}) } };
}

/** 构造 blob resource content（EmbeddedResource）。 */
function blobResource(uri: string, blob: string, mimeType?: string): McpContent {
	return { type: 'resource', resource: { uri, blob, ...(mimeType ? { mimeType } : {}) } };
}

/** 构造 resource link content。 */
function resourceLink(uri: string, description?: string, mimeType?: string): McpContent {
	return { type: 'resource_link', uri, ...(description ? { description } : {}), ...(mimeType ? { mimeType } : {}) };
}

describe('CallToolResult 归一化（6.7）', () => {
	it('text content 保留原文', () => {
		const result = normalizeCallToolResult({
			content: [text('Hello, World')],
		});
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('Hello, World'));
	});

	it('structuredContent 序列化为 JSON', () => {
		const result = normalizeCallToolResult({
			content: [],
			structuredContent: { key: 'value', count: 42 },
		});
		assert.ok(result.result?.includes('"key": "value"'));
		assert.ok(result.result?.includes('"count": 42'));
	});

	it('text resource 包含 URI 与 MIME', () => {
		const result = normalizeCallToolResult({
			content: [textResource('file:///path/to/file.txt', 'file content', 'text/plain')],
		});
		assert.ok(result.result?.includes('file:///path/to/file.txt'));
		assert.ok(result.result?.includes('text/plain'));
		assert.ok(result.result?.includes('file content'));
	});

	it('resource link 包含 URI 与 description', () => {
		const result = normalizeCallToolResult({
			content: [resourceLink('file:///docs/api.md', 'API 文档', 'text/markdown')],
		});
		assert.ok(result.result?.includes('file:///docs/api.md'));
		assert.ok(result.result?.includes('API 文档'));
		assert.ok(result.result?.includes('text/markdown'));
	});

	it('多段内容按顺序拼接', () => {
		const result = normalizeCallToolResult({
			content: [text('第一段'), text('第二段'), text('第三段')],
		});
		const idx1 = result.result?.indexOf('第一段') ?? -1;
		const idx2 = result.result?.indexOf('第二段') ?? -1;
		const idx3 = result.result?.indexOf('第三段') ?? -1;
		assert.ok(idx1 >= 0 && idx2 > idx1 && idx3 > idx2, `order not preserved: ${result.result}`);
	});

	it('空结果返回空字符串', () => {
		const result = normalizeCallToolResult({
			content: [],
		});
		assert.strictEqual(result.status, 'success');
		assert.strictEqual(result.result, '');
	});

	it('isError true 转为 error 状态', () => {
		const result = normalizeCallToolResult({
			content: [text('参数错误：query 不能为空')],
			isError: true,
		});
		assert.strictEqual(result.status, 'error');
		assert.ok(result.result?.includes('参数错误'));
		assert.strictEqual(result.metadata?.isError, true);
	});

	it('未知类型返回安全描述且标记 unsupportedContent', () => {
		const result = normalizeCallToolResult({
			content: [{ type: 'video', data: 'some-data' } as McpContent],
		});
		assert.strictEqual(result.status, 'success');
		assert.ok(result.metadata?.unsupportedContent, 'should mark unsupportedContent');
		// 不包含原始 data
		assert.ok(!result.result?.includes('some-data'), 'should not include raw data');
	});

	it('text 与 structuredContent 同时存在时都保留', () => {
		const result = normalizeCallToolResult({
			content: [text('文本内容')],
			structuredContent: { items: [1, 2, 3] },
		});
		assert.ok(result.result?.includes('文本内容'));
		assert.ok(result.result?.includes('items'));
	});
});

describe('非文本内容安全描述（6.9）', () => {
	it('image content 不内联 base64', () => {
		const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
		const result = normalizeCallToolResult({
			content: [image('image/png', base64Data)],
		});
		assert.ok(!result.result?.includes(base64Data), 'base64 data must not appear in result');
		assert.strictEqual(result.metadata?.unsupportedContent, true);
		assert.ok(result.result?.includes('image'), 'should mention image type');
		assert.ok(result.result?.includes('image/png'), 'should mention MIME type');
	});

	it('audio content 不内联 base64', () => {
		const base64Data = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
		const result = normalizeCallToolResult({
			content: [audio('audio/wav', base64Data)],
		});
		assert.ok(!result.result?.includes(base64Data), 'base64 data must not appear in result');
		assert.strictEqual(result.metadata?.unsupportedContent, true);
		assert.ok(result.result?.includes('audio'));
		assert.ok(result.result?.includes('audio/wav'));
	});

	it('blob resource 不内联 base64', () => {
		const blobData = 'SGVsbG8gV29ybGQ=';
		const result = normalizeCallToolResult({
			content: [blobResource('file:///binary.dat', blobData, 'application/octet-stream')],
		});
		assert.ok(!result.result?.includes(blobData), 'blob data must not appear in result');
		assert.strictEqual(result.metadata?.unsupportedContent, true);
		assert.ok(result.result?.includes('file:///binary.dat'), 'should include URI');
	});

	it('混合 text 与 image 只保留 text 和安全描述', () => {
		const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
		const result = normalizeCallToolResult({
			content: [text('文本内容'), image('image/png', base64Data)],
		});
		assert.ok(result.result?.includes('文本内容'));
		assert.ok(!result.result?.includes(base64Data));
		assert.strictEqual(result.metadata?.unsupportedContent, true);
	});

	it('isError 与 unsupportedContent 可同时存在', () => {
		const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
		const result = normalizeCallToolResult({
			content: [text('错误信息'), image('image/png', base64Data)],
			isError: true,
		});
		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.metadata?.isError, true);
		assert.strictEqual(result.metadata?.unsupportedContent, true);
	});
});
