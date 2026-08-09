/**
 * Diff 可视化 - 封装 vscode.diff 命令，展示左右两文件对比。
 * Phase 2 用 VSCode 内置 diff 编辑器；inline webview diff 预览留 Phase 5。
 * vscode 访问可注入，便于无 vscode 单测。
 */
import * as logger from '../../logger';

/** vscode 能力的最小 shim（便于注入测试）。 */
export interface VsCodeShim {
	executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
	fileUri(fsPath: string): unknown;
}

type VsCodeApi = typeof import('vscode');
function vscodeApi(): VsCodeApi {
	return require('vscode');
}

const defaultShim: VsCodeShim = {
	executeCommand(command, ...args) {
		return vscodeApi().commands.executeCommand(command, ...args);
	},
	fileUri(fsPath) {
		return vscodeApi().Uri.file(fsPath);
	},
};

export class DiffViewer {
	private readonly shim: VsCodeShim;

	constructor(shim?: VsCodeShim) {
		this.shim = shim ?? defaultShim;
	}

	/** 打开左右两文件的 diff 对比视图。 */
	async showDiff(
		leftFsPath: string,
		rightFsPath: string,
		title: string
	): Promise<void> {
		logger.log(`[DiffViewer] 打开 diff 预览 - left=${leftFsPath}, right=${rightFsPath}, title=${title}`);
		await this.shim.executeCommand(
			'vscode.diff',
			this.shim.fileUri(leftFsPath),
			this.shim.fileUri(rightFsPath),
			title
		);
		logger.log(`[DiffViewer] 打开 diff 预览完成 - title=${title}`);
	}
}
