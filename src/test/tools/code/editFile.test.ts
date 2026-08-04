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

function deferredApproval(): {
	approval: ApprovalGateway;
	requested: Promise<void>;
	resolve: (decision: 'allow' | 'always' | 'deny') => void;
} {
	let markRequested!: () => void;
	let resolve!: (decision: 'allow' | 'always' | 'deny') => void;
	const requested = new Promise<void>((done) => {
		markRequested = done;
	});
	const approval = new ApprovalGateway({
		prompter: {
			prompt: async () => {
				markRequested();
				return new Promise((done) => {
					resolve = done;
				});
			},
		},
		store: { getAlwaysAllow: () => [], addAlwaysAllow: async () => {} },
	});
	return {
		approval,
		requested,
		resolve: (decision) => resolve(decision),
	};
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

	it('审批期间文件变化时拒绝过期 diff 并清理预览', async () => {
		await writeFile('a.ts', 'const value = "old";\n');
		const gate = deferredApproval();
		const tool = new CodeEditTool({
			approval: gate.approval,
			diffViewer: mockDiffViewer().viewer,
		});
		const execution = tool.execute(
			{ path: 'a.ts', oldString: '"old"', newString: '"agent"' },
			await makeContext()
		);
		await gate.requested;
		await writeFile('a.ts', 'const value = "user";\n');

		gate.resolve('allow');
		const result = await execution;

		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('并发修改'));
		assert.strictEqual(result.metadata?.retryable, false);
		assert.strictEqual(
			await fs.readFile(path.join(workspace, 'a.ts'), 'utf8'),
			'const value = "user";\n'
		);
		const dirEntries = await fs.readdir(workspace);
		assert.ok(!dirEntries.some((entry) => entry.includes('code-edit-preview')));
	});

	it('审批等待期间取消后不得应用编辑', async () => {
		await writeFile('a.ts', 'before\n');
		const gate = deferredApproval();
		const abortController = new AbortController();
		const tool = new CodeEditTool({
			approval: gate.approval,
			diffViewer: mockDiffViewer().viewer,
		});
		const execution = tool.execute(
			{ path: 'a.ts', oldString: 'before', newString: 'after' },
			await makeContext({ abortSignal: abortController.signal })
		);
		await gate.requested;

		abortController.abort();
		gate.resolve('allow');
		const result = await execution;

		assert.strictEqual(result.status, 'cancelled');
		assert.strictEqual(await fs.readFile(path.join(workspace, 'a.ts'), 'utf8'), 'before\n');
	});

	it('expectedVersion 不匹配时在审批前拒绝', async () => {
		await writeFile('a.ts', 'hello\n');
		let promptCount = 0;
		const approval = new ApprovalGateway({
			prompter: {
				prompt: async () => {
					promptCount++;
					return 'allow';
				},
			},
			store: { getAlwaysAllow: () => [], addAlwaysAllow: async () => {} },
		});
		const tool = new CodeEditTool({
			approval,
			diffViewer: mockDiffViewer().viewer,
		});

		const result = await tool.execute(
			{
				path: 'a.ts',
				oldString: 'hello',
				newString: 'world',
				expectedVersion: 'stale-version',
			},
			await makeContext()
		);

		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.metadata?.retryable, false);
		assert.strictEqual(promptCount, 0);
		assert.strictEqual(await fs.readFile(path.join(workspace, 'a.ts'), 'utf8'), 'hello\n');
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

	it('CRLF 文件 + LF 入参：换行符归一化后匹配成功', async () => {
		// Arrange：文件用 CRLF，LLM 发来的 oldString/newString 用 LF
		await writeFile('readme.md', 'line1\r\nline2\r\nline3\r\n');
		const tool = new CodeEditTool({
			approval: mockApproval('allow'),
			diffViewer: mockDiffViewer().viewer,
		});
		// Act：oldString 用 \n（LF），文件用 \r\n（CRLF）
		const result = await tool.execute(
			{ path: 'readme.md', oldString: 'line2\nline3', newString: 'changed\nchanged' },
			await makeContext()
		);
		// Assert：归一化后匹配成功
		assert.strictEqual(result.status, 'success');
		const written = await fs.readFile(path.join(workspace, 'readme.md'), 'utf8');
		assert.ok(written.includes('changed\r\nchanged'));
		assert.ok(!written.includes('line2'));
	});

	it('LF 文件 + CRLF 入参：换行符归一化后匹配成功', async () => {
		// Arrange：文件用 LF，LLM 发来的 oldString 用 CRLF
		await writeFile('readme.md', 'line1\nline2\nline3\n');
		const tool = new CodeEditTool({
			approval: mockApproval('allow'),
			diffViewer: mockDiffViewer().viewer,
		});
		// Act：oldString 用 \r\n（CRLF），文件用 \n（LF）
		const result = await tool.execute(
			{ path: 'readme.md', oldString: 'line2\r\nline3', newString: 'changed\r\nchanged' },
			await makeContext()
		);
		// Assert：归一化后匹配成功，写入保持文件的 LF 风格
		assert.strictEqual(result.status, 'success');
		const written = await fs.readFile(path.join(workspace, 'readme.md'), 'utf8');
		assert.ok(written.includes('changed\nchanged'));
		assert.ok(!written.includes('line2'));
	});
});
