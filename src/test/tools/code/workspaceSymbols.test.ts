import * as assert from 'assert';
import {
	WorkspaceSymbolsTool,
	type VsCodeCommandsShim,
} from '../../../tools/code/workspaceSymbols';
import type { ToolContext } from '../../../tools/baseTool';

/** SymbolInformation 最小结构工厂。 */
function makeSymbol(
	name: string,
	kind: number,
	fsPath: string,
	line: number,
	character: number
) {
	return {
		name,
		kind,
		location: {
			uri: { fsPath },
			range: { start: { line, character } },
		},
	};
}

/** 构造 mock VsCodeCommandsShim，返回预设符号列表。 */
function mockShim(symbols: unknown[] | null, error?: Error): VsCodeCommandsShim {
	return {
		executeCommand: async (_command: string, ..._args: unknown[]) => {
			if (error) {
				throw error;
			}
			return symbols;
		},
	};
}

describe('WorkspaceSymbolsTool', () => {
	const context: ToolContext = { workspaceRoots: ['/workspace'] };

	it('搜索到函数符号（kind=12）', async () => {
		// Arrange
		const shim = mockShim([
			makeSymbol('getServiceBaseUrl', 12, '/workspace/src/service.ts', 10, 9),
		]);
		const tool = new WorkspaceSymbolsTool({ vscode: shim });

		// Act
		const result = await tool.execute({ query: 'getServiceBaseUrl' }, context);

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result as string);
		assert.strictEqual(payload.symbols.length, 1);
		assert.strictEqual(payload.symbols[0].name, 'getServiceBaseUrl');
		assert.strictEqual(payload.symbols[0].kind, 'Function');
		assert.strictEqual(payload.symbols[0].file, '/workspace/src/service.ts');
		assert.strictEqual(payload.symbols[0].line, 10);
		assert.strictEqual(payload.symbols[0].column, 9);
		assert.strictEqual(payload.truncated, undefined);
		assert.strictEqual(payload.total, undefined);
	});

	it('无匹配符号返回空数组', async () => {
		// Arrange
		const shim = mockShim([]);
		const tool = new WorkspaceSymbolsTool({ vscode: shim });

		// Act
		const result = await tool.execute({ query: 'nonexistent' }, context);

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result as string);
		assert.deepStrictEqual(payload.symbols, []);
		assert.strictEqual(payload.truncated, undefined);
	});

	it('超过 100 个结果时截断', async () => {
		// Arrange：构造 150 个符号
		const symbols = Array.from({ length: 150 }, (_, i) =>
			makeSymbol(`symbol${i}`, 13, `/workspace/f${i}.ts`, i, 0)
		);
		const shim = mockShim(symbols);
		const tool = new WorkspaceSymbolsTool({ vscode: shim });

		// Act
		const result = await tool.execute({ query: 'symbol' }, context);

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result as string);
		assert.strictEqual(payload.symbols.length, 100);
		assert.strictEqual(payload.truncated, true);
		assert.strictEqual(payload.total, 150);
	});

	it('validate 拒绝空 query', () => {
		// Arrange
		const tool = new WorkspaceSymbolsTool({ vscode: mockShim([]) });

		// Act & Assert
		assert.throws(() => tool.validate({ query: '' }));
		assert.throws(() => tool.validate({}));
	});

	it('命令执行失败返回 error', async () => {
		// Arrange
		const shim = mockShim(null, new Error('language server unavailable'));
		const tool = new WorkspaceSymbolsTool({ vscode: shim });

		// Act
		const result = await tool.execute({ query: 'foo' }, context);

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('工作区符号搜索失败'));
		assert.ok(result.error?.includes('language server unavailable'));
	});
});
