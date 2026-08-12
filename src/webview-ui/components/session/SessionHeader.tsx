/**
 * 会话头部组件。
 *
 * 职责：展示与编辑会话标题、新建会话、打开历史下拉（列表请求/打开/删除会话）。
 * 删除会话由宿主弹确认框，删除当前会话后宿主显式通知 `currentSessionDeleted`。
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { post } from '../../bridge/vscode';
import type { SessionMeta } from '../../protocol';
import { formatRelativeTime } from '../../utils/format';

/** 头部组件属性。 */
export interface SessionHeaderProps {
	/** 当前会话 ID（null 表示尚未创建或已被删除） */
	currentSessionId: string | null;
	/** 当前会话标题 */
	sessionTitle: string;
	/** 历史会话列表 */
	sessions: SessionMeta[];
}

/** 历史会话下拉项。 */
function HistoryItem({ session, active, onOpen, onDelete }: {
	session: SessionMeta;
	active: boolean;
	onOpen: (sessionId: string) => void;
	onDelete: (sessionId: string) => void;
}): JSX.Element {
	return (
		<div
			className={`history-item${active ? ' active' : ''}`}
			role="button"
			tabIndex={0}
			onClick={() => onOpen(session.sessionId)}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onOpen(session.sessionId);
				}
			}}
		>
			<div className="history-item-main">
				<div className="history-item-title">{session.title || '新会话'}</div>
				<div className="history-item-meta">
					{formatRelativeTime(session.updatedAt)} · {session.messageCount} 条消息
				</div>
			</div>
			<button
				type="button"
				className="history-item-del"
				title="删除会话"
				aria-label={`删除会话 ${session.title || '新会话'}`}
				onClick={(e) => {
					e.stopPropagation();
					onDelete(session.sessionId);
				}}
			>
				<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
					<path d="M6 1h4v1h3v1H3V2h3V1zM4 4h8v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4zm2 2v7h1V6H6zm3 0v7h1V6H9z" />
				</svg>
			</button>
		</div>
	);
}

/** 会话头部：标题编辑 + 新建/历史操作。 */
export function SessionHeader({ currentSessionId, sessionTitle, sessions }: SessionHeaderProps): JSX.Element {
	const [title, setTitle] = useState(sessionTitle);
	const [historyOpen, setHistoryOpen] = useState(false);
	const headerRef = useRef<HTMLDivElement>(null);

	// 外部标题变更（打开历史会话/删除）时同步输入框
	useEffect(() => {
		setTitle(sessionTitle || 'Untitled');
	}, [sessionTitle]);

	// 点击外部关闭历史下拉
	useEffect(() => {
		if (!historyOpen) return;
		const onClick = (e: MouseEvent): void => {
			if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
				setHistoryOpen(false);
			}
		};
		document.addEventListener('click', onClick);
		return () => document.removeEventListener('click', onClick);
	}, [historyOpen]);

	/** 标题失焦时重命名会话。 */
	const commitTitle = (): void => {
		const name = title.trim() || 'Untitled';
		setTitle(name);
		if (currentSessionId) {
			post({ command: 'renameSession', sessionId: currentSessionId, name });
		}
	};

	/** 打开历史下拉：请求最新会话列表。 */
	const toggleHistory = (): void => {
		if (historyOpen) {
			setHistoryOpen(false);
			return;
		}
		setHistoryOpen(true);
		post({ command: 'requestSessions' });
	};

	/** 打开历史会话：交由宿主切换指针并回推 openSession。 */
	const openSession = (sessionId: string): void => {
		setHistoryOpen(false);
		post({ command: 'openSession', sessionId });
	};

	/** 删除会话：宿主弹确认框，确认后删除并回推最新 sessionList。 */
	const deleteSession = (sessionId: string): void => {
		post({ command: 'deleteSession', sessionId });
	};

	return (
		<div id="header" ref={headerRef}>
			<input
				id="sessionNameInput"
				className="session-name-input"
				type="text"
				value={title}
				placeholder="会话名称"
				aria-label="会话名称"
				disabled={!currentSessionId}
				onChange={(e) => setTitle(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						(e.target as HTMLInputElement).blur();
					}
				}}
				onBlur={commitTitle}
			/>
			<div className="session-actions">
				<button
					type="button"
					id="newSessionIconBtn"
					className="btn btn-icon"
					title="新建会话"
					aria-label="新建会话"
					onClick={() => post({ command: 'createSession' })}
				>
					<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
						<path d="M7.25 1a.75.75 0 0 1 .75.75V7h5.25a.75.75 0 0 1 0 1.5H8v5.25a.75.75 0 0 1-1.5 0V8.5H1.25a.75.75 0 0 1 0-1.5H6.5V1.75A.75.75 0 0 1 7.25 1z" />
					</svg>
				</button>
				<button
					type="button"
					id="historyIconBtn"
					className="btn btn-icon"
					title="历史会话"
					aria-label="历史会话"
					aria-expanded={historyOpen}
					onClick={toggleHistory}
				>
					<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
						<path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5A5.5 5.5 0 1 1 2.5 8 5.5 5.5 0 0 1 8 2.5z" />
						<path d="M7.25 4.5v3.42L10.3 9.5l.4-1.16-2.45-1.2V4.5h-1z" />
					</svg>
				</button>
			</div>
			{/* 历史下拉：必须是 #header 的子元素，绝对定位才相对 header 底部展开 */}
			{historyOpen && (
				<div id="historyDropdown" className="history-dropdown" role="listbox" aria-label="历史会话">
					<div className="history-dropdown-header">历史会话</div>
					<div id="historyList" className="history-list">
						{sessions.length === 0 ? (
							<div className="history-empty">暂无历史会话</div>
						) : (
							sessions.map((s) => (
								<HistoryItem
									key={s.sessionId}
									session={s}
									active={s.sessionId === currentSessionId}
									onOpen={openSession}
									onDelete={deleteSession}
								/>
							))
						)}
					</div>
				</div>
			)}
		</div>
	);
}
