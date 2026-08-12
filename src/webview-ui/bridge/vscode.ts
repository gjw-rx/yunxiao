/**
 * VS Code Webview API 桥接层。
 *
 * 职责：在模块作用域仅调用一次 `acquireVsCodeApi()`（VS Code 要求每个 webview
 * 只获取一次实例），并提供类型化的发送（`post`）与订阅（`subscribe`）接口，
 * 屏蔽底层 `window.postMessage` 细节。
 */
import type { HostToWebviewMessage, WebviewToHostMessage } from '../protocol';

/** VS Code 注入的 webview API 形状（仅声明本工程使用到的成员）。 */
interface VsCodeApi {
	/** 读取持久化状态（webview 重建后可恢复）。 */
	getState: () => unknown;
	/** 写入持久化状态。 */
	setState: (state: unknown) => void;
	/** 向扩展宿主发送 JSON 可序列化消息。 */
	postMessage: (message: unknown) => void;
}

/** `acquireVsCodeApi` 由 VS Code 注入到 webview 全局作用域（非标准 DOM API）。 */
declare function acquireVsCodeApi<T = unknown>(): {
	getState: () => T | undefined;
	setState: (state: T) => void;
	postMessage: (message: unknown) => void;
};

/**
 * 模块级单例：仅在模块首次加载时调用一次 `acquireVsCodeApi()`。
 * 后续所有发送与订阅复用同一实例，避免重复获取导致的状态丢失。
 */
const api: VsCodeApi = acquireVsCodeApi();

/**
 * 向扩展宿主发送类型化的 Webview → Host 消息。
 *
 * @param message 待发送的消息（命令名与字段与宿主协议兼容）
 */
export function post(message: WebviewToHostMessage): void {
	api.postMessage(message);
}

/**
 * 订阅宿主消息（Host → Webview），仅转发带 `command` 字段的对象。
 *
 * @param listener 消息监听回调
 * @returns 取消订阅函数
 */
export function subscribe(listener: (message: HostToWebviewMessage) => void): () => void {
	const handler = (event: MessageEvent): void => {
		const msg = event.data as HostToWebviewMessage | null;
		const command = (msg as { command?: unknown } | null)?.command;
		if (msg && typeof msg === 'object' && typeof command === 'string') {
			listener(msg);
		}
	};
	window.addEventListener('message', handler);
	return () => window.removeEventListener('message', handler);
}
