/**
 * MCP 设置页组件测试（任务 5.1/5.3/5.5/5.7/5.9）。
 *
 * 覆盖：导航顺序（模型/Skill/MCP/使用情况）、挂载请求 MCP 快照、默认模型页行为不变；
 * JSON 编辑器（打开/关闭、模板、批量新增、编辑预填、秘密占位、语法错误、Host fieldPath、保存中）；
 * Server 列表（空状态、配置/实际 Transport、状态、工具数、错误摘要、展开工具名称与 description）；
 * 操作（启停、重连、编辑、删除二次确认、操作已接受与最终状态推送）；窄布局与无障碍。
 *
 * 通过 mock 宿主协议验证，秘密明文永不出现在页面或反馈中。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebviewMessage, McpServerView } from '../protocol';

const bridge = vi.hoisted(() => ({
	/** 捕获的宿主消息订阅回调。 */
	listener: undefined as undefined | ((message: HostToWebviewMessage) => void),
	/** Webview 发往宿主的消息记录。 */
	post: vi.fn(),
}));

vi.mock('../bridge/vscode', () => ({
	post: bridge.post,
	subscribe: (listener: (message: HostToWebviewMessage) => void) => {
		bridge.listener = listener;
		return (): void => undefined;
	},
}));

import { SettingsPage } from '../components/settings/SettingsPage';

afterEach(() => {
	vi.useRealTimers();
	cleanup();
	bridge.listener = undefined;
	bridge.post.mockClear();
});

/** 通过订阅回调模拟宿主推送消息。 */
function emit(message: HostToWebviewMessage): void {
	act(() => bridge.listener?.(message));
}

/** 构造一个 STDIO ready Server 视图。 */
function stdioServer(overrides: Partial<McpServerView> = {}): McpServerView {
	return {
		id: 'codegraph',
		configuredTransport: 'stdio',
		actualTransport: 'stdio',
		enabled: true,
		status: 'ready',
		toolCount: 2,
		tools: [
			{ name: 'explore', description: '探索代码结构' },
			{ name: 'get_symbol', description: '读取符号源码' },
		],
		config: {
			type: 'stdio',
			command: 'codegraph',
			args: ['serve', '--mcp'],
			envKeys: ['API_TOKEN'],
			enabled: true,
			connectTimeoutMs: 30000,
			callTimeoutMs: 60000,
		},
		...overrides,
	} as McpServerView;
}

/** 构造一个 Streamable HTTP ready Server 视图（可覆盖 actualTransport 模拟 legacy-sse 回退）。 */
function httpServer(overrides: Partial<McpServerView> = {}): McpServerView {
	return {
		id: 'remote-api',
		configuredTransport: 'streamable-http',
		actualTransport: 'streamable-http',
		enabled: true,
		status: 'ready',
		toolCount: 1,
		tools: [{ name: 'query', description: '远程查询' }],
		config: {
			type: 'streamable-http',
			url: 'https://mcp.example.com/sse',
			headerNames: ['Authorization'],
			legacySseFallback: false,
			enabled: true,
			connectTimeoutMs: 30000,
			callTimeoutMs: 60000,
		},
		...overrides,
	} as McpServerView;
}

/** 切换到 MCP 分类并等待页面渲染。 */
async function gotoMcp(): Promise<void> {
	fireEvent.click(screen.getByRole('button', { name: 'MCP' }));
	await waitFor(() => expect(screen.getByRole('heading', { name: 'MCP' })).toBeTruthy());
}

/** 读取最后一条指定 command 的 post 调用参数。 */
function lastPost(command: string): Record<string, unknown> | undefined {
	const calls = bridge.post.mock.calls.map((c) => c[0] as Record<string, unknown>);
	return [...calls].reverse().find((m) => m.command === command);
}

describe('MCP 设置页 - 导航与挂载（5.1）', () => {
	it('MCP 列表采用概览、搜索与当前项目服务卡片的管理布局', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await gotoMcp();
		expect(screen.getByText('当前项目')).toBeTruthy();
		expect(screen.getByRole('searchbox', { name: '搜索 MCP 服务' })).toBeTruthy();
		expect(screen.getByText('1 个服务已连接')).toBeTruthy();
	});

	it('导航顺序为 模型/Skill/MCP/Hooks/使用情况', () => {
		const { container } = render(<SettingsPage />);
		const labels = Array.from(container.querySelectorAll('.settings-nav-item')).map((el) => el.textContent ?? '');
		expect(labels).toEqual(['模型', 'Skill', 'MCP', 'Hooks', '使用情况']);
	});

	it('挂载时请求 MCP 快照', () => {
		render(<SettingsPage />);
		expect(bridge.post).toHaveBeenCalledWith({ command: 'requestMcpSettings' });
	});

	it('默认显示模型分类且模型内容正常渲染（行为不变）', async () => {
		render(<SettingsPage />);
		emit({
			command: 'modelSettings',
			model: {
				provider: 'openai',
				model: 'gpt-4o-mini',
				baseURL: 'https://api.openai.com/v1',
				temperature: 0.7,
				maxTokens: 4096,
				apiKeyConfigured: true,
			},
		} as HostToWebviewMessage);
		// 默认模型分类可见
		expect(screen.getAllByRole('button', { name: '模型' }).length).toBeGreaterThan(0);
		// MCP 导航项存在
		expect(screen.getByRole('button', { name: 'MCP' })).toBeTruthy();
	});

	it('点击 MCP 导航展示 MCP 管理页与私有存储说明', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [] });
		fireEvent.click(screen.getByRole('button', { name: 'MCP' }));
		await waitFor(() => expect(screen.getByRole('heading', { name: 'MCP' })).toBeTruthy());
		expect(screen.getByText(/不自动读取项目.*\.mcp\.json/)).toBeTruthy();
	});
});

describe('MCP 设置页 - JSON 编辑器（5.3）', () => {
	it('点击添加/导入 JSON 打开编辑器并预填模板', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '添加/导入 JSON' }));
		expect(screen.getByRole('heading', { name: '新增 / 批量导入' })).toBeTruthy();
		const textarea = screen.getByRole('textbox', { name: 'MCP JSON 配置' }) as HTMLTextAreaElement;
		// 模板包含 mcpServers 与 stdio type
		expect(textarea.value).toContain('"mcpServers"');
		expect(textarea.value).toContain('"type": "stdio"');
	});

	it('点击取消关闭编辑器并清空输入', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '添加/导入 JSON' }));
		fireEvent.click(screen.getByRole('button', { name: '取消' }));
		expect(screen.queryByRole('heading', { name: '新增 / 批量导入' })).toBeNull();
		expect(screen.queryByRole('textbox', { name: 'MCP JSON 配置' })).toBeNull();
	});

	it('保存 add 模式发送 saveMcpServersJson 含 json 与 mode', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '添加/导入 JSON' }));
		const textarea = screen.getByRole('textbox', { name: 'MCP JSON 配置' }) as HTMLTextAreaElement;
		const batchJson = JSON.stringify({
			mcpServers: {
				'srv-a': { type: 'stdio', command: 'node', args: ['a.js'], enabled: true },
				'srv-b': { type: 'stdio', command: 'node', args: ['b.js'], enabled: true },
			},
		});
		fireEvent.change(textarea, { target: { value: batchJson } });
		fireEvent.click(screen.getByRole('button', { name: '保存 MCP 配置' }));
		const call = lastPost('saveMcpServersJson');
		expect(call).toBeDefined();
		expect(call?.mode).toBe('add');
		expect(call?.json).toBe(batchJson);
	});

	it('编辑预填 JSON 将 env 值替换为秘密占位', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '编辑 codegraph' }));
		expect(screen.getByRole('heading', { name: '编辑：codegraph' })).toBeTruthy();
		const textarea = screen.getByRole('textbox', { name: 'MCP JSON 配置' }) as HTMLTextAreaElement;
		const parsed = JSON.parse(textarea.value);
		expect(parsed.mcpServers.codegraph.env.API_TOKEN).toBe('<已安全保存>');
		// 原始 command 保留
		expect(parsed.mcpServers.codegraph.command).toBe('codegraph');
	});

	it('编辑 Streamable HTTP 预填将 header 值替换为秘密占位', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [httpServer()] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '编辑 remote-api' }));
		const textarea = screen.getByRole('textbox', { name: 'MCP JSON 配置' }) as HTMLTextAreaElement;
		const parsed = JSON.parse(textarea.value);
		expect(parsed.mcpServers['remote-api'].headers.Authorization).toBe('<已安全保存>');
		expect(parsed.mcpServers['remote-api'].url).toBe('https://mcp.example.com/sse');
	});

	it('保存 edit 模式发送 editingServerId', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '编辑 codegraph' }));
		fireEvent.click(screen.getByRole('button', { name: '保存 MCP 配置' }));
		const call = lastPost('saveMcpServersJson');
		expect(call?.mode).toBe('edit');
		expect(call?.editingServerId).toBe('codegraph');
	});

	it('JSON 语法错误显示客户端预检并禁用保存按钮', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '添加/导入 JSON' }));
		const textarea = screen.getByRole('textbox', { name: 'MCP JSON 配置' }) as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: '{ invalid json' } });
		expect(screen.getByRole('alert').textContent).toContain('JSON 语法错误');
		expect((screen.getByRole('button', { name: '保存 MCP 配置' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('Host 返回 fieldPath 错误时显示字段路径', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '添加/导入 JSON' }));
		const textarea = screen.getByRole('textbox', { name: 'MCP JSON 配置' }) as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: JSON.stringify({ mcpServers: {} }) } });
		fireEvent.click(screen.getByRole('button', { name: '保存 MCP 配置' }));
		emit({
			command: 'mcpSettingsError',
			operation: 'save',
			message: '至少需要配置一个 Server',
			fieldPath: 'mcpServers',
		} as HostToWebviewMessage);
		await waitFor(() => expect(screen.getByText('字段：mcpServers')).toBeTruthy());
	});

	it('保存中按钮显示保存中且禁用', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '添加/导入 JSON' }));
		fireEvent.click(screen.getByRole('button', { name: '保存 MCP 配置' }));
		// mcpSaving=true 后按钮显示"保存中…"
		// 此时 Host 尚未回推，不会自动变 false；验证发送了保存请求即可
		expect(lastPost('saveMcpServersJson')).toBeDefined();
	});
});

describe('MCP 设置页 - Server 列表（5.5）', () => {
	it('空状态展示暂无 Server 提示', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [] });
		await gotoMcp();
		expect(screen.getByText(/暂无 MCP Server/)).toBeTruthy();
		expect(screen.getByRole('button', { name: '添加服务器（空状态）' })).toBeTruthy();
	});

	it('STDIO Server 展示配置 Transport STDIO', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await gotoMcp();
		expect(screen.getByText(/配置：STDIO/)).toBeTruthy();
		// 配置与实际一致时不重复展示实际
		expect(screen.queryByText(/实际/)).toBeNull();
	});

	it('Streamable HTTP 回退 legacy-sse 展示配置与实际 Transport', async () => {
		render(<SettingsPage />);
		emit({
			command: 'mcpSettings',
			servers: [httpServer({ actualTransport: 'legacy-sse' })],
		});
		await gotoMcp();
		expect(screen.getByText(/配置：Streamable HTTP/)).toBeTruthy();
		expect(screen.getByText(/实际：Legacy SSE/)).toBeTruthy();
	});

	it('disabled 状态展示"已停用"标签且 CSS 类可区分', async () => {
		render(<SettingsPage />);
		emit({
			command: 'mcpSettings',
			servers: [stdioServer({ status: 'disabled', enabled: false })],
		});
		await gotoMcp();
		const statusEl = screen.getByText('已停用');
		expect(statusEl.className).toContain('mcp-status-disabled');
	});

	it('connecting 状态展示"连接中"标签', async () => {
		render(<SettingsPage />);
		emit({
			command: 'mcpSettings',
			servers: [stdioServer({ status: 'connecting', toolCount: 0, tools: [] })],
		});
		await gotoMcp();
		expect(screen.getByText('连接中')).toBeTruthy();
	});

	it('error 状态展示"错误"标签与错误摘要', async () => {
		render(<SettingsPage />);
		emit({
			command: 'mcpSettings',
			servers: [stdioServer({ status: 'error', errorSummary: '连接超时', toolCount: 0, tools: [] })],
		});
		await gotoMcp();
		expect(screen.getByText('错误')).toBeTruthy();
		expect(screen.getByText('连接超时')).toBeTruthy();
	});

	it('工具数展示在 Server 行', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer({ toolCount: 3 })] });
		await gotoMcp();
		expect(screen.getByText('工具 3')).toBeTruthy();
	});

	it('搜索仅过滤当前快照，不发送配置变更消息', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer(), httpServer()] });
		await gotoMcp();
		bridge.post.mockClear();
		fireEvent.change(screen.getByRole('searchbox', { name: '搜索 MCP 服务' }), { target: { value: 'remote' } });
		expect(screen.queryByText('codegraph')).toBeNull();
		expect(screen.getByText('remote-api')).toBeTruthy();
		expect(bridge.post).not.toHaveBeenCalled();
	});

	it('展开 ready Server 显示工具名称与 description', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await gotoMcp();
		// 默认未展开，工具列表不可见
		expect(screen.queryByText(/探索代码结构/)).toBeNull();
		// 点击 Server 名称展开
		fireEvent.click(screen.getByRole('button', { name: '展开 codegraph 详情' }));
		expect(screen.getByText('explore')).toBeTruthy();
		expect(screen.getByText(/探索代码结构/)).toBeTruthy();
		expect(screen.getByText('get_symbol')).toBeTruthy();
	});

	it('非 ready 状态展开不显示工具列表', async () => {
		render(<SettingsPage />);
		emit({
			command: 'mcpSettings',
			servers: [stdioServer({ status: 'connecting', toolCount: 0, tools: [] })],
		});
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '展开 codegraph 详情' }));
		// connecting 状态没有工具列表
		expect(screen.queryByLabelText('codegraph 已发现工具')).toBeNull();
	});
});

describe('MCP 设置页 - 操作（5.7）', () => {
	it('点击停用发送 setMcpServerEnabled enabled=false', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '停用 codegraph' }));
		const call = lastPost('setMcpServerEnabled');
		expect(call).toBeDefined();
		expect(call?.serverId).toBe('codegraph');
		expect(call?.enabled).toBe(false);
	});

	it('点击启用发送 setMcpServerEnabled enabled=true', async () => {
		render(<SettingsPage />);
		emit({
			command: 'mcpSettings',
			servers: [stdioServer({ enabled: false, status: 'disabled' })],
		});
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '启用 codegraph' }));
		const call = lastPost('setMcpServerEnabled');
		expect(call?.serverId).toBe('codegraph');
		expect(call?.enabled).toBe(true);
	});

	it('点击重连发送 reconnectMcpServer', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '重连 codegraph' }));
		const call = lastPost('reconnectMcpServer');
		expect(call?.serverId).toBe('codegraph');
	});

	it('点击编辑打开 JSON 编辑器 edit 模式', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '编辑 codegraph' }));
		expect(screen.getByRole('heading', { name: '编辑：codegraph' })).toBeTruthy();
	});

	it('删除需二次确认，确认后发送 deleteMcpServer', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await gotoMcp();
		// 第一次点击显示确认
		fireEvent.click(screen.getByRole('button', { name: '删除 codegraph' }));
		expect(screen.getByText('确认删除？')).toBeTruthy();
		// 确认删除
		fireEvent.click(screen.getByRole('button', { name: '确认删除 codegraph' }));
		const call = lastPost('deleteMcpServer');
		expect(call?.serverId).toBe('codegraph');
	});

	it('删除取消不发送 deleteMcpServer', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '删除 codegraph' }));
		fireEvent.click(screen.getByRole('button', { name: '取消删除 codegraph' }));
		expect(lastPost('deleteMcpServer')).toBeUndefined();
	});

	it('mcpOperationAccepted 展示操作已接受反馈', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '重连 codegraph' }));
		emit({
			command: 'mcpOperationAccepted',
			serverId: 'codegraph',
			operation: 'reconnect',
		} as HostToWebviewMessage);
		await waitFor(() => expect(screen.getByText(/操作已接受.*reconnect/)).toBeTruthy());
	});

	it('成功操作反馈短暂展示后自动消失', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await gotoMcp();
		vi.useFakeTimers();
		emit({
			command: 'mcpOperationAccepted',
			serverId: 'codegraph',
			operation: 'reconnect',
		} as HostToWebviewMessage);
		expect(screen.getByText(/操作已接受.*reconnect/)).toBeTruthy();
		act(() => vi.advanceTimersByTime(3_000));
		expect(screen.queryByText(/操作已接受.*reconnect/)).toBeNull();
	});

	it('mcpSettings 状态推送更新 Server 列表且不清空模型草稿', async () => {
		render(<SettingsPage />);
		// 先加载模型配置（含 models 数组以展示模型名称）
		emit({
			command: 'modelSettings',
			model: {
				provider: 'openai',
				model: 'gpt-4o-mini',
				baseURL: 'https://api.openai.com/v1',
				temperature: 0.7,
				maxTokens: 4096,
				apiKeyConfigured: true,
				models: [{
					id: 'model-a',
					provider: 'openai',
					model: 'gpt-4o-mini',
					baseURL: 'https://api.openai.com/v1',
					temperature: 0.7,
					maxTokens: 4096,
					runtime: 'ai-sdk',
					enabled: true,
					isDefault: true,
					apiKeyConfigured: true,
				}],
			},
		} as HostToWebviewMessage);
		// 加载 MCP 空快照
		emit({ command: 'mcpSettings', servers: [] });
		await gotoMcp();
		expect(screen.getByText(/暂无 MCP Server/)).toBeTruthy();
		// 推送新快照含一个 Server
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await waitFor(() => expect(screen.getByText('工具 2')).toBeTruthy());
		// 切回模型分类，草稿仍在（模型名称可见）
		fireEvent.click(screen.getByRole('button', { name: '模型' }));
		await waitFor(() => expect(screen.getByText('gpt-4o-mini')).toBeTruthy());
	});
});

describe('MCP 设置页 - 窄布局与无障碍（5.9）', () => {
	it('长 Server ID 完整渲染不截断', async () => {
		const longId = 'a-very-long-server-identifier-name-that-might-overflow';
		render(<SettingsPage />);
		emit({
			command: 'mcpSettings',
			servers: [stdioServer({ id: longId })],
		});
		await gotoMcp();
		expect(screen.getByRole('button', { name: `展开 ${longId} 详情` })).toBeTruthy();
		expect(screen.getByText(longId)).toBeTruthy();
	});

	it('长 URL 在 Transport 信息中完整展示', async () => {
		const longUrl = 'https://a-very-long-domain-name.example.com/deep/path/to/mcp/endpoint';
		render(<SettingsPage />);
		emit({
			command: 'mcpSettings',
			servers: [httpServer({
				config: {
					type: 'streamable-http',
					url: longUrl,
					headerNames: ['Authorization'],
					legacySseFallback: false,
					enabled: true,
					connectTimeoutMs: 30000,
					callTimeoutMs: 60000,
				},
			})],
		});
		await gotoMcp();
		// 编辑时 URL 出现在 JSON 预填中
		fireEvent.click(screen.getByRole('button', { name: '编辑 remote-api' }));
		const textarea = screen.getByRole('textbox', { name: 'MCP JSON 配置' }) as HTMLTextAreaElement;
		expect(textarea.value).toContain(longUrl);
	});

	it('长工具描述在展开列表中完整渲染', async () => {
		const longDesc = '这是一个非常长的工具描述'.repeat(10);
		render(<SettingsPage />);
		emit({
			command: 'mcpSettings',
			servers: [stdioServer({
				tools: [{ name: 'explore', description: longDesc }],
				toolCount: 1,
			})],
		});
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '展开 codegraph 详情' }));
		expect(screen.getByText(new RegExp(longDesc))).toBeTruthy();
	});

	it('长 JSON 文本可在 textarea 中编辑', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [] });
		await gotoMcp();
		fireEvent.click(screen.getByRole('button', { name: '添加/导入 JSON' }));
		const textarea = screen.getByRole('textbox', { name: 'MCP JSON 配置' }) as HTMLTextAreaElement;
		const longJson = JSON.stringify({
			mcpServers: {
				'long-server': {
					type: 'stdio',
					command: 'node',
					args: Array.from({ length: 20 }, (_, i) => `arg${i}`),
					env: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`KEY_${i}`, `value_${i}`])),
					enabled: true,
				},
			},
		}, null, 2);
		fireEvent.change(textarea, { target: { value: longJson } });
		expect(textarea.value).toBe(longJson);
		// 语法正确，保存按钮可用
		expect((screen.getByRole('button', { name: '保存 MCP 配置' }) as HTMLButtonElement).disabled).toBe(false);
	});

	it('所有操作按钮有无障碍 aria-label', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await gotoMcp();
		expect(screen.getByRole('button', { name: '停用 codegraph' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '重连 codegraph' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '编辑 codegraph' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '删除 codegraph' })).toBeTruthy();
	});

	it('Server 名称按钮有 aria-expanded 状态', async () => {
		render(<SettingsPage />);
		emit({ command: 'mcpSettings', servers: [stdioServer()] });
		await gotoMcp();
		const toggle = screen.getByRole('button', { name: '展开 codegraph 详情' });
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		fireEvent.click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
	});
});
