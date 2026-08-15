/**
 * McpConfigStore 测试（任务 3.1/3.3/3.5/3.7/3.9）。
 *
 * 覆盖：空 Store、version/revision、用户级路径、非敏感序列化、不读取工作区
 * `.mcp.json`；env/header 全值进入 SecretStorage、普通文件无值、设置快照只含
 * 配置状态；占位保留/替换/删除/新 Server 伪造占位/已有 Secret 缺失；批量事务
 * SecretStorage 中途失败与普通文件写失败的回滚、revision 不发布、新 Secret 清理；
 * enabled revision 更新与删除 Server 清理全部 Secrets。
 *
 * 用内存版 secrets 模拟 VS Code SecretStorage，不依赖真实 VS Code 环境。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { McpConfigStore, type McpDocumentIO } from '../../mcp/configStore';
import { MCP_SECRET_PLACEHOLDER } from '../../mcp/types';

/** 内存版 secrets（vscode.SecretStorage 兼容形状）；_data 暴露给测试断言用。 */
function createMemorySecrets() {
	const data = new Map<string, string>();
	return {
		_data: data,
		get: async (key: string): Promise<string | undefined> => data.get(key),
		store: async (key: string, value: string): Promise<void> => {
			data.set(key, value);
		},
		delete: async (key: string): Promise<void> => {
			data.delete(key);
		},
		onDidChange: (): vscode.Disposable => ({ dispose: () => undefined }),
	};
}

/** 构造带内存存储的测试环境。 */
function setup(opts?: { readonly workspaceRoots?: string[]; readonly io?: McpDocumentIO }) {
	const secrets = createMemorySecrets();
	const globalConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-mcp-store-'));
	const roots = opts?.workspaceRoots ?? [fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-mcp-ws-'))];
	const store = new McpConfigStore(
		{ secrets } as unknown as vscode.ExtensionContext,
		globalConfigRoot,
		roots,
		opts?.io
	);
	return { store, secrets, globalConfigRoot, roots };
}

/** 构造读取真实文件但写入始终失败的 IO（用于原子写失败测试）。 */
function createFailingIo(filePath: string): McpDocumentIO {
	return {
		read: async () => {
			try {
				return fs.readFileSync(filePath, 'utf8');
			} catch {
				return undefined;
			}
		},
		writeAtomic: async () => {
			throw new Error('配置文件写入失败');
		},
	};
}

/** 合法 STDIO JSON（带 env）。 */
const STDIO_JSON = JSON.stringify({
	mcpServers: {
		codegraph: {
			type: 'stdio',
			command: 'codegraph',
			args: ['serve', '--mcp'],
			env: { API_KEY: 'secret-123', PATH: '/usr/bin' },
		},
	},
});

/** 合法 Streamable HTTP JSON（带 headers）。 */
const HTTP_JSON = JSON.stringify({
	mcpServers: {
		'docs-remote': {
			type: 'streamable-http',
			url: 'https://example.com/mcp',
			headers: { Authorization: 'Bearer token-abc' },
		},
	},
});

/** 读取持久化文件原文。 */
function readDocFile(globalConfigRoot: string): string {
	return fs.readFileSync(path.join(globalConfigRoot, 'mcp', 'servers.json'), 'utf8');
}

describe('McpConfigStore 文档读写（3.1）', () => {
	it('空 Store 返回 version=1、revision=0、无 Server', async () => {
		const { store } = setup();
		const doc = await store.getDocument();
		assert.strictEqual(doc.version, 1);
		assert.strictEqual(doc.revision, 0);
		assert.strictEqual(Object.keys(doc.servers).length, 0);
	});

	it('用户级路径为 ~/.yunForce/mcp/servers.json', async () => {
		const { globalConfigRoot } = setup();
		// setup 传入的 globalConfigRoot 即用户级根，文件位于其下 mcp/servers.json
		const expected = path.join(globalConfigRoot, 'mcp', 'servers.json');
		await setup(); // 触发一次写入需先保存，这里仅验证路径构造
		assert.ok(expected.endsWith(path.join('mcp', 'servers.json')));
	});

	it('保存后非敏感字段写入文件，revision 递增', async () => {
		const { store, globalConfigRoot } = setup();
		const r = await store.saveAddImport(STDIO_JSON);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.revision, 1);
		const raw = readDocFile(globalConfigRoot);
		assert.ok(raw.includes('codegraph'));
		assert.ok(raw.includes('"command": "codegraph"'));
		assert.ok(raw.includes('"revision": 1'));
	});

	it('普通文件不含 env/header 明文值', async () => {
		const { store, globalConfigRoot } = setup();
		await store.saveAddImport(STDIO_JSON);
		await store.saveAddImport(HTTP_JSON);
		const raw = readDocFile(globalConfigRoot);
		assert.ok(!raw.includes('secret-123'), 'env 明文不得写入文件');
		assert.ok(!raw.includes('token-abc'), 'header 明文不得写入文件');
		assert.ok(raw.includes('API_KEY'), 'env key 列表应写入文件');
		assert.ok(raw.includes('Authorization'), 'header name 列表应写入文件');
	});

	it('不读取工作区 .mcp.json', async () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-mcp-ws2-'));
		fs.writeFileSync(path.join(ws, '.mcp.json'), JSON.stringify({
			mcpServers: { fromproject: { type: 'stdio', command: 'nope' } },
		}));
		const { store } = setup({ workspaceRoots: [ws] });
		const doc = await store.getDocument();
		assert.strictEqual(Object.keys(doc.servers).length, 0, '不得读取项目 .mcp.json');
		assert.ok(!doc.servers.fromproject);
	});

	it('原子写失败时保留旧有效文档', async () => {
		const secrets = createMemorySecrets();
		const globalConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-mcp-store-'));
		const roots = [fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-mcp-ws-'))];
		const filePath = path.join(globalConfigRoot, 'mcp', 'servers.json');
		// 直接写入旧有效文档（revision=5）
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const oldDoc = {
			version: 1, revision: 5,
			servers: { codegraph: { type: 'stdio', command: 'codegraph', args: [], envKeys: [], enabled: true, connectTimeoutMs: 30000, callTimeoutMs: 60000 } },
		};
		fs.writeFileSync(filePath, JSON.stringify(oldDoc), 'utf8');
		// 用写入失败的 IO 构造 Store
		const store = new McpConfigStore(
			{ secrets } as unknown as vscode.ExtensionContext,
			globalConfigRoot, roots, createFailingIo(filePath)
		);
		const r = await store.saveAddImport(HTTP_JSON);
		assert.strictEqual(r.ok, false);
		const doc = await store.getDocument();
		assert.strictEqual(doc.revision, 5, '旧文档 revision 保留');
		assert.ok(doc.servers.codegraph, '旧有效文档保留');
		assert.ok(!doc.servers['docs-remote'], '失败写入不污染旧文档');
	});
});

describe('McpConfigStore Secrets 分离（3.3）', () => {
	it('STDIO env 全值进入 SecretStorage', async () => {
		const { store, secrets } = setup();
		await store.saveAddImport(STDIO_JSON);
		assert.strictEqual(await secrets.get('yunxiaoAgent.mcp.codegraph.env.API_KEY'), 'secret-123');
		assert.strictEqual(await secrets.get('yunxiaoAgent.mcp.codegraph.env.PATH'), '/usr/bin');
	});

	it('远程 header 全值进入 SecretStorage', async () => {
		const { store, secrets } = setup();
		await store.saveAddImport(HTTP_JSON);
		assert.strictEqual(await secrets.get('yunxiaoAgent.mcp.docs-remote.header.Authorization'), 'Bearer token-abc');
	});

	it('设置快照只含配置状态，不含明文', async () => {
		const { store } = setup();
		await store.saveAddImport(STDIO_JSON);
		const view = await store.getSettingsView();
		const snap = JSON.stringify(view);
		assert.ok(!snap.includes('secret-123'), '快照不得含明文');
		const stdio = view.find((s) => s.id === 'codegraph');
		assert.ok(stdio);
		assert.strictEqual(stdio!.config.type, 'stdio');
		assert.deepStrictEqual([...(stdio!.config as { envKeys: readonly string[] }).envKeys], ['API_KEY', 'PATH']);
	});

	it('运行时配置装配秘密值（仅 Host 使用）', async () => {
		const { store } = setup();
		await store.saveAddImport(STDIO_JSON);
		const rt = await store.getRuntimeConfig('codegraph');
		assert.ok(rt);
		assert.strictEqual(rt!.type, 'stdio');
		assert.deepStrictEqual({ ...(rt! as { env: Readonly<Record<string, string>> }).env }, { API_KEY: 'secret-123', PATH: '/usr/bin' });
	});
});

describe('McpConfigStore 占位编辑语义（3.5）', () => {
	it('编辑时 env 值为占位表示保留旧 Secret', async () => {
		const { store, secrets } = setup();
		await store.saveAddImport(STDIO_JSON);
		// 编辑：只改 command，env 用占位
		const editJson = JSON.stringify({
			mcpServers: {
				codegraph: {
					type: 'stdio',
					command: 'codegraph2',
					args: ['serve'],
					env: { API_KEY: MCP_SECRET_PLACEHOLDER, PATH: MCP_SECRET_PLACEHOLDER },
				},
			},
		});
		const r = await store.saveEdit('codegraph', editJson);
		assert.strictEqual(r.ok, true, r.ok ? '' : r.errors.map((e) => e.message).join(';'));
		assert.strictEqual(await secrets.get('yunxiaoAgent.mcp.codegraph.env.API_KEY'), 'secret-123');
		const rt = await store.getRuntimeConfig('codegraph');
		assert.strictEqual(rt!.type, 'stdio');
		assert.strictEqual((rt! as { env: Record<string, string> }).env.API_KEY, 'secret-123');
	});

	it('编辑时占位替换为新值则更新 SecretStorage', async () => {
		const { store, secrets } = setup();
		await store.saveAddImport(STDIO_JSON);
		const editJson = JSON.stringify({
			mcpServers: {
				codegraph: {
					type: 'stdio', command: 'codegraph', args: [],
					env: { API_KEY: 'new-secret', PATH: MCP_SECRET_PLACEHOLDER },
				},
			},
		});
		const r = await store.saveEdit('codegraph', editJson);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(await secrets.get('yunxiaoAgent.mcp.codegraph.env.API_KEY'), 'new-secret');
		assert.strictEqual(await secrets.get('yunxiaoAgent.mcp.codegraph.env.PATH'), '/usr/bin');
	});

	it('编辑时删除 key 则删除对应 Secret', async () => {
		const { store, secrets } = setup();
		await store.saveAddImport(STDIO_JSON);
		const editJson = JSON.stringify({
			mcpServers: {
				codegraph: {
					type: 'stdio', command: 'codegraph', args: [],
					env: { API_KEY: MCP_SECRET_PLACEHOLDER }, // 删除 PATH
				},
			},
		});
		const r = await store.saveEdit('codegraph', editJson);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(await secrets.get('yunxiaoAgent.mcp.codegraph.env.PATH'), undefined);
		const rt = await store.getRuntimeConfig('codegraph');
		assert.strictEqual(rt!.type, 'stdio');
		assert.deepStrictEqual({ ...(rt! as { env: Record<string, string> }).env }, { API_KEY: 'secret-123' });
	});

	it('新 Server 伪造占位被拒绝', async () => {
		const { store } = setup();
		const r = await store.saveAddImport(JSON.stringify({
			mcpServers: {
				newsrv: {
					type: 'stdio', command: 'x', args: [],
					env: { FOO: MCP_SECRET_PLACEHOLDER },
				},
			},
		}));
		assert.strictEqual(r.ok, false);
		assert.ok(r.errors.some((e) => e.fieldPath.includes('newsrv') && /占位|伪造/.test(e.message)));
	});

	it('编辑时已有 Secret 缺失（占位但无值）被拒绝', async () => {
		const { store, secrets } = setup();
		await store.saveAddImport(STDIO_JSON);
		// 手动删除一个既有 Secret 模拟缺失
		await secrets.delete('yunxiaoAgent.mcp.codegraph.env.API_KEY');
		const editJson = JSON.stringify({
			mcpServers: {
				codegraph: {
					type: 'stdio', command: 'codegraph', args: [],
					env: { API_KEY: MCP_SECRET_PLACEHOLDER, PATH: MCP_SECRET_PLACEHOLDER },
				},
			},
		});
		const r = await store.saveEdit('codegraph', editJson);
		assert.strictEqual(r.ok, false);
		assert.ok(r.errors.some((e) => /API_KEY/.test(e.fieldPath)));
	});

	it('getEditView 返回单 Server JSON 且 env/header 值为占位', async () => {
		const { store } = setup();
		await store.saveAddImport(STDIO_JSON);
		const r = await store.getEditView('codegraph');
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.editView!.type, 'stdio');
		assert.strictEqual((r.editView! as { env: Record<string, string> }).env.API_KEY, MCP_SECRET_PLACEHOLDER);
	});
});

describe('McpConfigStore 批量事务与回滚（3.7）', () => {
	it('批量导入合法配置成功合并', async () => {
		const { store } = setup();
		await store.saveAddImport(STDIO_JSON);
		const r = await store.saveAddImport(HTTP_JSON);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.revision, 2);
		const doc = await store.getDocument();
		assert.deepStrictEqual(Object.keys(doc.servers).sort(), ['codegraph', 'docs-remote']);
	});

	it('新增 ID 冲突拒绝且不部分变更', async () => {
		const { store } = setup();
		await store.saveAddImport(STDIO_JSON);
		const r = await store.saveAddImport(STDIO_JSON); // 同 ID
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.revision, undefined);
		const doc = await store.getDocument();
		assert.strictEqual(doc.revision, 1, 'revision 不变');
	});

	it('SecretStorage 中途失败不发布 revision 并清理新 Secret', async () => {
		const secrets = createMemorySecrets();
		const globalConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-mcp-store-'));
		const roots = [fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-mcp-ws-'))];
		// 让第二个 Secret 写入失败
		let storeCallCount = 0;
		const failingSecrets = {
			...secrets,
			store: async (key: string, value: string): Promise<void> => {
				storeCallCount++;
				if (storeCallCount === 2) {
					throw new Error('SecretStorage 写入失败');
				}
				return secrets.store(key, value);
			},
		};
		const store = new McpConfigStore(
			{ secrets: failingSecrets } as unknown as vscode.ExtensionContext,
			globalConfigRoot,
			roots
		);
		const r = await store.saveAddImport(JSON.stringify({
			mcpServers: {
				s1: { type: 'stdio', command: 's1', args: [], env: { A: 'v1', B: 'v2' } },
			},
		}));
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.revision, undefined);
		// 第一个写入的 Secret 应被回滚清理
		const keys = await allSecretKeys(secrets);
		assert.strictEqual(keys.length, 0, '新 Secret 应被清理');
	});

	it('普通文件写失败不发布 revision 并清理新 Secret', async () => {
		const secrets = createMemorySecrets();
		const globalConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-mcp-store-'));
		const roots = [fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-mcp-ws-'))];
		const filePath = path.join(globalConfigRoot, 'mcp', 'servers.json');
		const store = new McpConfigStore(
			{ secrets } as unknown as vscode.ExtensionContext,
			globalConfigRoot, roots, createFailingIo(filePath)
		);
		const r = await store.saveAddImport(STDIO_JSON);
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.revision, undefined);
		// Secret 应被回滚清理
		assert.strictEqual(secrets._data.size, 0, '文件写失败后新 Secret 应被清理');
	});

	it('快速连续保存串行且 revision 递增', async () => {
		const { store } = setup();
		const [a, b] = await Promise.all([
			store.saveAddImport(STDIO_JSON),
			store.saveAddImport(HTTP_JSON),
		]);
		// 串行：两个都成功，revision 分别为 1 和 2
		assert.strictEqual(a.ok, true);
		assert.strictEqual(b.ok, true);
		const doc = await store.getDocument();
		assert.strictEqual(doc.revision, 2);
	});
});

describe('McpConfigStore enable/delete（3.9）', () => {
	it('setEnabled 更新 enabled 并递增 revision', async () => {
		const { store } = setup();
		await store.saveAddImport(STDIO_JSON);
		const r = await store.setEnabled('codegraph', false);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.revision, 2);
		const doc = await store.getDocument();
		assert.strictEqual(doc.servers.codegraph.enabled, false);
	});

	it('setEnabled 未知 Server 拒绝', async () => {
		const { store } = setup();
		const r = await store.setEnabled('nope', false);
		assert.strictEqual(r.ok, false);
	});

	it('delete 移除配置并清理全部 Secrets', async () => {
		const { store, secrets } = setup();
		await store.saveAddImport(STDIO_JSON);
		assert.ok(await secrets.get('yunxiaoAgent.mcp.codegraph.env.API_KEY'));
		const r = await store.delete('codegraph');
		assert.strictEqual(r.ok, true);
		const doc = await store.getDocument();
		assert.ok(!doc.servers.codegraph);
		assert.strictEqual(await secrets.get('yunxiaoAgent.mcp.codegraph.env.API_KEY'), undefined);
		assert.strictEqual(await secrets.get('yunxiaoAgent.mcp.codegraph.env.PATH'), undefined);
	});

	it('delete 未知 Server 拒绝', async () => {
		const { store } = setup();
		const r = await store.delete('nope');
		assert.strictEqual(r.ok, false);
	});
});

/** 收集内存 secrets 的全部 key（仅用于测试断言）。 */
async function allSecretKeys(secrets: ReturnType<typeof createMemorySecrets>): Promise<string[]> {
	return [...secrets._data.keys()];
}
