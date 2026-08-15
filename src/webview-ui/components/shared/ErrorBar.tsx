/**
 * 错误提示条组件。
 *
 * 职责：展示宿主推送的错误消息，5 秒后自动清空（与迁移前行为一致）。
 */
import { useEffect, type JSX } from 'react';

/** 错误条属性。 */
export interface ErrorBarProps {
	/** 错误文本（空则不展示） */
	message: string;
	/** 清空错误（定时器到期时由本组件触发） */
	onClear: () => void;
}

/** 错误提示条。 */
export function ErrorBar({ message, onClear }: ErrorBarProps): JSX.Element | null {
	useEffect(() => {
		if (!message) return;
		const timer = window.setTimeout(onClear, 5000);
		return () => window.clearTimeout(timer);
	}, [message, onClear]);

	return <div id="error">{message}</div>;
}
