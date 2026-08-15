/**
 * MCP 配置解析、归一化与事务计划测试（任务 2.1/2.3/2.5/2.7）。
 *
 * 覆盖：空输入、语法错误、顶层结构、批量 Server、合法 STDIO/HTTP、未知 type、
 * 未知字段、精确 fieldPath；STDIO 字段（command/args/env/enabled/超时/默认 cwd/
 * 相对 cwd/绝对与越界 cwd）；远程 URL（HTTPS/loopback HTTP/非 loopback 拒绝/
 * userinfo）；导入语义（批量原子失败/新增 ID 冲突/编辑单 Server/禁止重命名）。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	parseMcpServersJson,
	normalizeStdioConfig,
	normalizeHttpConfig,
	normalizeServerConfig,
	planAddImport,
	planEdit,
	DEFAULT_CONNECT_TIMEOUT_MS,
	DEFAULT_CALL_TIMEOUT_MS,
} from '../../mcp/configParser';
import type { McpServerConfig } from '../../mcp/types';

/** 创建临时工作区根目录。 */
function tmpRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-mcp-cfg-'));
}

/** 合法 STDIO JSON 文本。 */
const STDIO_JSON = JSON.stringify({
	mcpServers: {
		codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'], env: { PATH: '/usr/bin' } },
	},
});

/** 合法 Streamable HTTP JSON 文本。 */
const HTTP_JSON = JSON.stringify({
	mcpServers: {
		'docs-remote': { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
	},
});

describe('MCP 配置解析 parseMcpServersJson（2.1）', () => {
	it('空输入拒绝', () => {
		const r = parseMcpServersJson('');
		assert.strictEqual(r.ok, false);
		assert.match(r.errors[0].fieldPath, /mcpServers/);
	});

	it('JSON 语法错误拒绝并返回可读信息', () => {
		const r = parseMcpServersJson('{ not json');
		assert.strictEqual(r.ok, false);
		assert.match(r.errors[0].message, /语法错误/);
	});

	it('顶层非对象拒绝', () => {
		const r = parseMcpServersJson('[]');
		assert.strictEqual(r.ok, false);
		assert.match(r.errors[0].message, /顶层结构/);
	});

	it('缺少 mcpServers 字段拒绝', () => {
		const r = parseMcpServersJson('{"foo":1}');
		assert.strictEqual(r.ok, false);
		assert.match(r.errors[0].message, /未知字段|仅允许 mcpServers/);
	});

	it('顶层未知字段拒绝并定位到该字段', () => {
		const r = parseMcpServersJson('{"mcpServers":{},"extra":1}');
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.errors[0].fieldPath, 'extra');
	});

	it('合法 STDIO 解析成功', () => {
		const r = parseMcpServersJson(STDIO_JSON);
		assert.strictEqual(r.ok, true, r.errors.map((e) => e.message).join(';'));
		assert.strictEqual(r.servers.codegraph.type, 'stdio');
		assert.deepStrictEqual([...(r.servers.codegraph as { args: readonly string[] }).args], ['serve', '--mcp']);
	});

	it('合法 Streamable HTTP 解析成功', () => {
		const r = parseMcpServersJson(HTTP_JSON);
		assert.strictEqual(r.ok, true, r.errors.map((e) => e.message).join(';'));
		assert.strictEqual(r.servers['docs-remote'].type, 'streamable-http');
	});

	it('批量 Server 同时解析', () => {
		const r = parseMcpServersJson(JSON.stringify({
			mcpServers: {
				a: { type: 'stdio', command: 'a' },
				b: { type: 'streamable-http', url: 'https://b.example/mcp' },
			},
		}));
		assert.strictEqual(r.ok, true);
		assert.strictEqual(Object.keys(r.servers).length, 2);
	});

	it('未知 type 拒绝并定位到 type 字段', () => {
		const r = parseMcpServersJson(JSON.stringify({ mcpServers: { bad: { type: 'websocket', url: 'wss://x' } } }));
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.errors[0].fieldPath, 'mcpServers.bad.type');
		assert.match(r.errors[0].message, /websocket/);
	});

	it('streamable_http 下划线写法兼容并归一化为 streamable-http', () => {
		const r = parseMcpServersJson(JSON.stringify({ mcpServers: { tavily: { type: 'streamable_http', url: 'https://example.com/mcp' } } }));
		assert.strictEqual(r.ok, true, r.errors.map((e) => e.message).join(';'));
		assert.strictEqual(r.servers.tavily.type, 'streamable-http');
	});

	it('未知字段拒绝并定位到精确字段路径', () => {
		const r = parseMcpServersJson(JSON.stringify({ mcpServers: { a: { type: 'stdio', command: 'a', bogus: 1 } } }));
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.errors[0].fieldPath, 'mcpServers.a.bogus');
	});

	it('批量中单个非法导致整体失败', () => {
		const r = parseMcpServersJson(JSON.stringify({
			mcpServers: {
				good: { type: 'stdio', command: 'good' },
				bad: { type: 'stdio' }, // 缺 command，严格 parser 在解析阶段即拒绝
			},
		}));
		// 严格 parser：command 缺失在解析阶段拒绝，整体失败并定位到该字段
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.errors[0].fieldPath, 'mcpServers.bad.command');
	});
});

describe('MCP STDIO 归一化 normalizeStdioConfig（2.3）', () => {
	let root: string;
	before(() => { root = tmpRoot(); });

	it('command 为空拒绝', async () => {
		// 空字符串通过 parser 类型校验（command 为 string），归一化阶段非空检查拒绝
		const parsed = parseMcpServersJson(JSON.stringify({ mcpServers: { a: { type: 'stdio', command: '' } } }));
		assert.strictEqual(parsed.ok, true);
		const r = await normalizeStdioConfig('a', parsed.servers.a as never, [root]);
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.errors[0].fieldPath, 'mcpServers.a.command');
	});

	it('args/env 字符串类型通过，env 值剥离为 key 列表', async () => {
		const parsed = parseMcpServersJson(STDIO_JSON);
		const r = await normalizeStdioConfig('codegraph', parsed.servers.codegraph as never, [root]);
		assert.strictEqual(r.ok, true, r.errors.map((e) => e.message).join(';'));
		const cfg = r.config as { envKeys: readonly string[]; args: readonly string[] };
		assert.deepStrictEqual([...cfg.envKeys], ['PATH']);
		assert.deepStrictEqual([...cfg.args], ['serve', '--mcp']);
	});

	it('enabled 缺省为 true', async () => {
		const r = await normalizeStdioConfig('a', { type: 'stdio', command: 'a' }, [root]);
		assert.strictEqual((r.config as { enabled: boolean }).enabled, true);
	});

	it('超时缺省值与非法值', async () => {
		const ok = await normalizeStdioConfig('a', { type: 'stdio', command: 'a' }, [root]);
		assert.strictEqual((ok.config as { connectTimeoutMs: number }).connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
		assert.strictEqual((ok.config as { callTimeoutMs: number }).callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS);

		const bad = await normalizeStdioConfig('a', { type: 'stdio', command: 'a', connectTimeoutMs: 10 }, [root]);
		assert.strictEqual(bad.ok, false);
		assert.strictEqual(bad.errors[0].fieldPath, 'mcpServers.a.connectTimeoutMs');
	});

	it('默认 cwd 解析到首个工作区根', async () => {
		const r = await normalizeStdioConfig('a', { type: 'stdio', command: 'a' }, [root]);
		assert.strictEqual((r.config as { cwd?: string }).cwd, path.resolve(root));
	});

	it('相对 cwd 以工作区为根解析', async () => {
		const r = await normalizeStdioConfig('a', { type: 'stdio', command: 'a', cwd: 'sub/dir' }, [root]);
		assert.strictEqual((r.config as { cwd?: string }).cwd, path.resolve(root, 'sub/dir'));
	});

	it('绝对 cwd 在工作区内通过', async () => {
		const absSub = path.join(root, 'inside');
		fs.mkdirSync(absSub, { recursive: true });
		const r = await normalizeStdioConfig('a', { type: 'stdio', command: 'a', cwd: absSub }, [root]);
		assert.strictEqual(r.ok, true, r.errors.map((e) => e.message).join(';'));
	});

	it('越界 cwd 拒绝并定位字段', async () => {
		const r = await normalizeStdioConfig('a', { type: 'stdio', command: 'a', cwd: '../../../etc' }, [root]);
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.errors[0].fieldPath, 'mcpServers.a.cwd');
	});

	it('args 含 shell 元字符按原样保留（无 shell 拼接）', async () => {
		const r = await normalizeStdioConfig('a', { type: 'stdio', command: 'echo', args: ['a; rm -rf /', '$HOME', '|cat'] }, [root]);
		assert.strictEqual(r.ok, true);
		assert.deepStrictEqual([...(r.config as { args: readonly string[] }).args], ['a; rm -rf /', '$HOME', '|cat']);
	});
});

describe('MCP 远程 URL 归一化 normalizeHttpConfig（2.5）', () => {
	it('HTTPS URL 通过', () => {
		const r = normalizeHttpConfig('a', { type: 'streamable-http', url: 'https://example.com/mcp' });
		assert.strictEqual(r.ok, true, r.errors.map((e) => e.message).join(';'));
	});

	it('loopback HTTP 通过', () => {
		const r = normalizeHttpConfig('a', { type: 'streamable-http', url: 'http://127.0.0.1:8080/mcp' });
		assert.strictEqual(r.ok, true);
		const r2 = normalizeHttpConfig('a', { type: 'streamable-http', url: 'http://localhost/mcp' });
		assert.strictEqual(r2.ok, true);
	});

	it('非 loopback HTTP 拒绝', () => {
		const r = normalizeHttpConfig('a', { type: 'streamable-http', url: 'http://example.com/mcp' });
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.errors[0].fieldPath, 'mcpServers.a.url');
		assert.match(r.errors[0].message, /HTTPS|loopback/);
	});

	it('URL 含 userinfo 拒绝', () => {
		const r = normalizeHttpConfig('a', { type: 'streamable-http', url: 'https://user:pass@example.com/mcp' });
		assert.strictEqual(r.ok, false);
		assert.match(r.errors[0].message, /userinfo|用户信息/);
	});

	it('headers 类型通过并剥离为 name 列表', () => {
		const r = normalizeHttpConfig('a', { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x', 'X-Api-Key': 'y' } });
		assert.strictEqual(r.ok, true);
		assert.deepStrictEqual([...(r.config as { headerNames: readonly string[] }).headerNames].sort(), ['Authorization', 'X-Api-Key']);
	});

	it('legacySseFallback 缺省 false', () => {
		const r = normalizeHttpConfig('a', { type: 'streamable-http', url: 'https://example.com/mcp' });
		assert.strictEqual((r.config as { legacySseFallback: boolean }).legacySseFallback, false);
	});

	it('normalizeServerConfig 按 type 分派', async () => {
		const stdio = await normalizeServerConfig('a', { type: 'stdio', command: 'a' }, [tmpRoot()]);
		assert.strictEqual(stdio.config?.type, 'stdio');
		// HTTP 路径不使用 workspaceRoots，传空数组以匹配签名
		const http = normalizeServerConfig('a', { type: 'streamable-http', url: 'https://example.com/mcp' }, []);
		assert.strictEqual((await http).config?.type, 'streamable-http');
	});
});

describe('MCP 事务计划（2.7）', () => {
	const existingA: McpServerConfig = { type: 'stdio', command: 'a', args: [], envKeys: [], enabled: true, connectTimeoutMs: 30000, callTimeoutMs: 60000 };

	it('批量导入合法配置成功合并', () => {
		const incoming: Record<string, McpServerConfig> = {
			b: { type: 'streamable-http', url: 'https://b.example/mcp', headerNames: [], legacySseFallback: false, enabled: true, connectTimeoutMs: 30000, callTimeoutMs: 60000 },
		};
		const r = planAddImport({ a: existingA }, incoming);
		assert.strictEqual(r.ok, true);
		assert.deepStrictEqual(Object.keys(r.servers).sort(), ['a', 'b']);
	});

	it('新增 ID 冲突拒绝且不部分变更', () => {
		const incoming: Record<string, McpServerConfig> = { a: existingA };
		const r = planAddImport({ a: existingA }, incoming);
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.errors[0].fieldPath, 'mcpServers.a');
		assert.strictEqual(Object.keys(r.servers).length, 0);
	});

	it('批量中部分冲突导致整体失败', () => {
		const incoming: Record<string, McpServerConfig> = {
			a: existingA, // 冲突
			c: { ...existingA, command: 'c' },
		};
		const r = planAddImport({ a: existingA }, incoming);
		assert.strictEqual(r.ok, false);
		assert.strictEqual(Object.keys(r.servers).length, 0);
	});

	it('编辑只允许提交一个 Server', () => {
		const incoming: Record<string, McpServerConfig> = { a: existingA, b: { ...existingA, command: 'b' } };
		const r = planEdit({ a: existingA }, 'a', incoming);
		assert.strictEqual(r.ok, false);
		assert.match(r.errors[0].message, /仅允许提交一个/);
	});

	it('编辑禁止隐式重命名', () => {
		const incoming: Record<string, McpServerConfig> = { renamed: { ...existingA, command: 'renamed' } };
		const r = planEdit({ a: existingA }, 'a', incoming);
		assert.strictEqual(r.ok, false);
		assert.match(r.errors[0].message, /重命名/);
	});

	it('编辑不存在的 Server 拒绝', () => {
		const incoming: Record<string, McpServerConfig> = { a: existingA };
		const r = planEdit({}, 'a', incoming);
		assert.strictEqual(r.ok, false);
		assert.match(r.errors[0].message, /未找到/);
	});

	it('编辑合法替换并保留其他 Server', () => {
		const updated: McpServerConfig = { ...existingA, command: 'a-new' };
		const r = planEdit({ a: existingA, b: { ...existingA, command: 'b' } }, 'a', { a: updated });
		assert.strictEqual(r.ok, true);
		assert.strictEqual((r.servers.a as { command: string }).command, 'a-new');
		assert.strictEqual(Object.keys(r.servers).length, 2);
	});
});
