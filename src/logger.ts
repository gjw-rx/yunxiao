import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

function ensureChannel(): vscode.OutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel('云效 Agent');
	}
	return channel;
}

function ts(): string {
	return new Date().toISOString().replace('T', ' ').replace(/\..*/, '');
}

export function log(msg: string, ...args: unknown[]): void {
	const line = args.length ? `${msg} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}` : msg;
	const formatted = `[${ts()}] ${line}`;
	ensureChannel().appendLine(formatted);
	console.log(formatted);
}

export function error(msg: string, ...args: unknown[]): void {
	log(`[ERROR] ${msg}`, ...args);
}

/**
 * 错误通知：同时写入日志、在 VSCode 右下角弹出错误弹窗。
 * 弹窗带 "Show Logs" 按钮，点击后打开 Output Channel。
 */
export function notifyError(msg: string, ...args: unknown[]): void {
	error(msg, ...args);
	const detail = args.length
		? args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')
		: '';
	void vscode.window.showErrorMessage(
		`云效 Agent: ${msg}`,
		{ detail: detail.slice(0, 500), modal: false },
		'Show Logs',
	).then((action) => {
		if (action === 'Show Logs') {
			show();
		}
	});
}

export function show(preserveFocus = true): void {
	ensureChannel().show(preserveFocus);
}
