import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { CodeEditTool } from '../../../tools/code/editFile';
import { ApprovalGateway } from '../../../core/approvalGateway';
import { DiffViewer, type VsCodeShim } from '../../../tools/diff/diffViewer';
import type { ToolContext } from '../../../tools/baseTool';
import { createDiff } from '../../../tools/diff/diffEngine';

/** 构造 mock 审批网关：按给定决策响应。 */
function mockApproval(decision: 'allow' | 'always' | 'deny'): ApprovalGateway {
	return new ApprovalGateway({
		prompter: { prompt: async () => decision },
		store: { getAlwaysAllow: () => [], addAlwaysAllow: async () => {} },
	});
}

/** 构造 mock DiffViewer（不真正打开 diff，记录调用）。 */
function mockDiffViewer(): { viewer: DiffViewer; calls: string[] } {
	const calls: string[] = [];
	const shim: VsCodeShim = {
		executeCommand: async (cmd, ...args) => {
			calls.push(`${cmd}:${args[args.length - 1]}`);
			return undefined;
		},
		fileUri: (p) => p,
	};
	return { viewer: new DiffViewer(shim), calls };
}

describe('CodeEditTool', () => {
	let workspace: string;

	async function makeContext(overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
		return { workspaceRoots: [workspace], sessionId: 'sess-1', ...overrides };
	}

	async function writeFile(rel: string, content: string): Promise<void> {
		const abs = path.join(workspace, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content);
	}

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-codeedit-'));
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('精确替换唯一字符串成功', async () => {
		// Arrange
		await writeFile('ext.ts', 'export function getServiceBaseUrl() {}\n');
		const tool = new CodeEditTool({
			approval: mockApproval('allow'),
			diffViewer: mockDiffViewer().viewer,
		});
		// Act
		const result = await tool.execute(
			{
				path: 'ext.ts',
				oldString: 'getServiceBaseUrl',
				newString: 'getServiceUrl',
			},
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'success');
		const written = await fs.readFile(path.join(workspace, 'ext.ts'), 'utf8');
		assert.ok(written.includes('getServiceUrl'));
		assert.ok(!written.includes('getServiceBaseUrl'));
		assert.ok(result.metadata?.diff);
		assert.deepStrictEqual(result.metadata?.affected_files, ['ext.ts']);
	});

	it('多处匹配被拒绝，文件不变', async () => {
		// Arrange
		await writeFile('a.ts', 'foo\nfoo\nbar\n');
		const tool = new CodeEditTool({
			approval: mockApproval('allow'),
			diffViewer: mockDiffViewer().viewer,
		});
		// Act
		const result = await tool.execute(
			{ path: 'a.ts', oldString: 'foo', newString: 'baz' },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('多处匹配'));
		const written = await fs.readFile(path.join(workspace, 'a.ts'), 'utf8');
		assert.strictEqual(written, 'foo\nfoo\nbar\n'); // 未变
	});

	it('未找到字符串被拒绝', async () => {
		// Arrange
		await writeFile('a.ts', 'hello\n');
		const tool = new CodeEditTool({
			approval: mockApproval('allow'),
			diffViewer: mockDiffViewer().viewer,
		});
		// Act
		const result = await tool.execute(
			{ path: 'a.ts', oldString: 'nonexistent', newString: 'x' },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('未找到'));
	});

	it('并发修改检测：文件已变导致 oldString 不在', async () => {
		// Arrange：agent 基于 'old' 计算 oldString，但文件已被改为 'changed'
		await writeFile('a.ts', 'changed content\n');
		const tool = new CodeEditTool({
			approval: mockApproval('allow'),
			diffViewer: mockDiffViewer().viewer,
		});
		// Act
		const result = await tool.execute(
			{ path: 'a.ts', oldString: 'old', newString: 'new' },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('未找到'));
	});

	it('应用匹配的 patch 成功', async () => {
		// Arrange
		const original = 'line1\nline2\nline3\n';
		await writeFile('a.ts', original);
		const patch = createDiff(original, 'line1\nline2-changed\nline3\n', 'a.ts');
		const tool = new CodeEditTool({
			approval: mockApproval('allow'),
			diffViewer: mockDiffViewer().viewer,
		});
		// Act
		const result = await tool.execute({ path: 'a.ts', patch }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'success');
		const written = await fs.readFile(path.join(workspace, 'a.ts'), 'utf8');
		assert.ok(written.includes('line2-changed'));
	});

	it('冲突的 patch 被拒绝，文件不变', async () => {
		// Arrange
		const original = 'line1\nline2\nline3\n';
		await writeFile('a.ts', 'totally\ndifferent\ncontent\n');
		const patch = createDiff(original, 'line1\nline2-x\nline3\n', 'a.ts');
		const tool = new CodeEditTool({
			approval: mockApproval('allow'),
			diffViewer: mockDiffViewer().viewer,
		});
		// Act
		const result = await tool.execute({ path: 'a.ts', patch }, await makeContext());
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('冲突'));
	});

	it('审批拒绝返回 cancelled，文件不变且无残留预览', async () => {
		// Arrange
		await writeFile('a.ts', 'hello\n');
		const tool = new CodeEditTool({
			approval: mockApproval('deny'),
			diffViewer: mockDiffViewer().viewer,
		});
		// Act
		const result = await tool.execute(
			{ path: 'a.ts', oldString: 'hello', newString: 'world' },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'cancelled');
		const written = await fs.readFile(path.join(workspace, 'a.ts'), 'utf8');
		assert.strictEqual(written, 'hello\n'); // 未变
		const dirEntries = await fs.readdir(workspace);
		assert.ok(!dirEntries.some((e) => e.includes('code-edit-preview')));
	});

	it('diff 预览在应用前打开', async () => {
		// Arrange
		await writeFile('a.ts', 'hello\n');
		const { viewer, calls } = mockDiffViewer();
		const tool = new CodeEditTool({ approval: mockApproval('allow'), diffViewer: viewer });
		// Act
		await tool.execute(
			{ path: 'a.ts', oldString: 'hello', newString: 'world' },
			await makeContext()
		);
		// Assert
		assert.ok(calls.some((c) => c.startsWith('vscode.diff:')));
	});

	it('拒绝越界路径', async () => {
		const tool = new CodeEditTool({
			approval: mockApproval('allow'),
			diffViewer: mockDiffViewer().viewer,
		});
		const result = await tool.execute(
			{ path: '../../../etc/passwd', oldString: 'a', newString: 'b' },
			await makeContext()
		);
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('越界'));
	});

	it('validate 拒绝缺模式或双模式', () => {
		const tool = new CodeEditTool({
			approval: mockApproval('allow'),
			diffViewer: mockDiffViewer().viewer,
		});
		assert.throws(() => tool.validate({ path: 'a.ts' })); // 无模式
		assert.throws(() =>
			tool.validate({ path: 'a.ts', oldString: 'a', newString: 'b', patch: 'x' })
		); // 双模式
	});

	it('无变化时返回 success 且不写', async () => {
		// Arrange
		await writeFile('a.ts', 'hello\n');
		const tool = new CodeEditTool({
			approval: mockApproval('allow'),
			diffViewer: mockDiffViewer().viewer,
		});
		// Act：oldString === newString
		const result = await tool.execute(
			{ path: 'a.ts', oldString: 'hello', newString: 'hello' },
			await makeContext()
		);
		// Assert
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result?.includes('无变化'));
	});
});
