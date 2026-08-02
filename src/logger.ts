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

export function show(preserveFocus = true): void {
	ensureChannel().show(preserveFocus);
}
