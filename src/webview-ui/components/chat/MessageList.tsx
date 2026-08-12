/**
 * 消息流列表组件。
 *
 * 职责：按回合（turn）渲染消息流——用户消息独立行，思考/工具/计划/审批/Diff
 * 步骤与助手回复按发生顺序交错在回合容器内；处理流式追加、思考占位、
 * 复制/点赞/删除操作与 token 用量展示。
 */
import { useLayoutEffect, useRef, useState, type JSX, type UIEvent } from 'react';
import type { ApprovalEntry, DiffEntry, TokenUsageDetail, ToolEntry } from '../../protocol';
import type { ChatState, MessageItem } from '../../state/reducer';
import { isNearScrollBottom } from '../../utils/chatBehavior';
import { formatTokenUsage } from '../../utils/format';
import { ApprovalCard } from '../approval/ApprovalCard';
import { DiffCard } from '../diff/DiffCard';
import { Markdown } from '../shared/Markdown';
import { ThoughtIcon, PlanIcon } from '../shared/icons';
import { ToolStep } from '../tools/ToolStep';

/** 用户消息行。 */
function UserMessage({ text, onDelete }: { text: string; onDelete: () => void }): JSX.Element {
	return (
		<div className="msg-row user-row">
			<div className="message user">{text}</div>
			<div className="msg-actions">
				<button type="button" className="msg-action-btn delete-btn" title="删除此消息" aria-label="删除此消息" onClick={onDelete}>
					<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
						<path d="M2.5 4h11M5.5 4V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4M4.5 4v9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4" />
						<path d="M6.5 7.5v3.5M9.5 7.5v3.5" />
					</svg>
				</button>
			</div>
		</div>
	);
}

/** 复制图标与已复制图标。 */
function CopyIcon({ copied }: { copied: boolean }): JSX.Element {
	return copied ? (
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
			<path d="M3.5 8.5l3 3 6-6" />
		</svg>
	) : (
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
			<rect x="5" y="3" width="8" height="10" rx="1.5" />
			<path d="M3 5v7a1.5 1.5 0 0 0 1.5 1.5H11" />
		</svg>
	);
}

/** 点赞图标与已点赞图标。 */
function LikeIcon({ liked }: { liked: boolean }): JSX.Element {
	return liked ? (
		<svg viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
			<path d="M7 3.5L5.5 6.5v7h6l1.5-4V8h-4l.5-2.5L7 3.5z" />
			<path d="M5.5 6.5H3.5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h2" />
		</svg>
	) : (
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
			<path d="M7 3.5L5.5 6.5v7h6l1.5-4V8h-4l.5-2.5L7 3.5z" />
			<path d="M5.5 6.5H3.5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h2" />
		</svg>
	);
}

/** 复制文本（navigator.clipboard，失败时回退 textarea execCommand）。 */
async function copyText(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text || '');
	} catch {
		const textarea = document.createElement('textarea');
		textarea.value = text || '';
		document.body.appendChild(textarea);
		textarea.select();
		document.execCommand('copy');
		document.body.removeChild(textarea);
	}
}

/** 助手回复行（含操作栏与 token 用量）。 */
function AssistantMessage({ message, onDelete }: {
	message: { id: string; text: string; streaming: boolean; tokenUsage?: TokenUsageDetail };
	onDelete: () => void;
}): JSX.Element {
	const [copied, setCopied] = useState(false);
	const [liked, setLiked] = useState(false);
	const copyTimer = useRef<number | undefined>(undefined);
	const formatted = formatTokenUsage(message.tokenUsage);

	const handleCopy = (): void => {
		void copyText(message.text);
		setCopied(true);
		window.clearTimeout(copyTimer.current);
		copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
	};

	// 空文本且流式中：思考占位动画
	if (message.streaming && !message.text) {
		return (
			<div className="msg-row">
				<div className="msg-label">回复</div>
				<div className="message assistant thinking" role="status" aria-live="polite">
					<span>正在思考</span>
					<span className="thinking-dots" aria-hidden="true">
						<i />
						<i />
						<i />
					</span>
				</div>
			</div>
		);
	}

	return (
		<div className="msg-row">
			<div className="msg-label">回复</div>
			<div className={`message assistant${message.streaming ? ' cursor' : ''}`}>
				<Markdown text={message.text} />
			</div>
			<div className="msg-actions">
				<span className="token-usage" title={formatted.title}>
					<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="8" cy="8" r="6" />
						<path d="M8 4v4l2 2" />
					</svg>
					<span className="token-count">{formatted.text}</span>
				</span>
				<button type="button" className="msg-action-btn copy-btn" title="复制回复" aria-label="复制回复" onClick={handleCopy}>
					<CopyIcon copied={copied} />
				</button>
				<button
					type="button"
					className={`msg-action-btn like-btn${liked ? ' liked' : ''}`}
					title={liked ? '取消点赞' : '点赞'}
					aria-label={liked ? '取消点赞' : '点赞'}
					onClick={() => setLiked(!liked)}
				>
					<LikeIcon liked={liked} />
				</button>
				<button type="button" className="msg-action-btn delete-btn" title="删除此消息" aria-label="删除此消息" onClick={onDelete}>
					<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
						<path d="M2.5 4h11M5.5 4V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4M4.5 4v9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4" />
						<path d="M6.5 7.5v3.5M9.5 7.5v3.5" />
					</svg>
				</button>
			</div>
		</div>
	);
}

/** 思考步骤。 */
function ThoughtStep({ text }: { text: string }): JSX.Element {
	return (
		<div className="step thought">
			<span className="step-dot" aria-hidden="true" />
			<div className="step-head">
				<span className="step-icon">
					<ThoughtIcon />
				</span>
				<span className="step-name">思考</span>
			</div>
			<div className="step-body">{text}</div>
		</div>
	);
}

/** 计划步骤。 */
function PlanStep({ steps }: { steps: readonly string[] }): JSX.Element {
	return (
		<div className="step plan">
			<span className="step-dot" aria-hidden="true" />
			<div className="step-head">
				<span className="step-icon">
					<PlanIcon />
				</span>
				<span className="step-name">计划</span>
			</div>
			<ol>
				{steps.map((s, i) => (
					<li key={i}>{s}</li>
				))}
			</ol>
		</div>
	);
}

/** 上下文压缩步骤。 */
function CompactionStep({ active }: { active: boolean }): JSX.Element {
	return (
		<div className="step compaction">
			<span className="step-dot" aria-hidden="true" />
			<span className="step-name">{active ? '正在压缩上下文…' : '上下文压缩完成'}</span>
		</div>
	);
}

/** 消息流属性。 */
export interface MessageListProps {
	/** 全局聊天状态 */
	state: ChatState;
	/** 删除用户消息 */
	onDeleteUser: (messageId: string) => void;
	/** 删除助手消息所在回合 */
	onDeleteAssistant: (messageId: string) => void;
	/** 展开/收起工具步骤 */
	onToggleTool: (callId: string) => void;
	/** 展开/收起 Diff 卡 */
	onToggleDiff: (callId: string) => void;
	/** 审批已决定（标记退场） */
	onResolveApproval: (callId: string) => void;
}

/** 消息流列表：按回合分组渲染。 */
export function MessageList({ state, onDeleteUser, onDeleteAssistant, onToggleTool, onToggleDiff, onResolveApproval }: MessageListProps): JSX.Element {
	const { messages, toolEntries, approvals, diffs } = state;
	const messagesRef = useRef<HTMLDivElement>(null);
	const shouldFollowRef = useRef(true);

	/**
	 * 在用户仍停留在底部时，随流式消息与工具状态更新保持底部可见。
	 *
	 * @returns 无返回值
	 */
	useLayoutEffect(() => {
		const container = messagesRef.current;
		if (container && shouldFollowRef.current) {
			container.scrollTop = container.scrollHeight;
		}
	}, [messages, toolEntries, approvals, diffs]);

	/**
	 * 记录用户是否主动离开底部；离开后不再强制滚动。
	 *
	 * @param event 消息列表滚动事件
	 * @returns 无返回值
	 */
	const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
		const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
		shouldFollowRef.current = isNearScrollBottom({ scrollTop, clientHeight, scrollHeight });
	};

	const groups: JSX.Element[] = [];
	let turnItems: JSX.Element[] = [];
	let turnKey = 0;
	let turnOpen = false;

	/** 渲染单个消息项（非 user）。 */
	const renderItem = (m: MessageItem): JSX.Element => {
		switch (m.kind) {
			case 'assistant':
				return (
					<AssistantMessage
						key={m.id}
						message={{ id: m.id, text: m.text, streaming: m.streaming, tokenUsage: m.tokenUsage }}
						onDelete={() => onDeleteAssistant(m.id)}
					/>
				);
			case 'thought':
				return <ThoughtStep key={m.id} text={m.text} />;
			case 'plan':
				return <PlanStep key={m.id} steps={m.steps} />;
			case 'tool': {
				const entry: ToolEntry | undefined = toolEntries[m.callId];
				if (!entry) return <span key={m.id} />;
				return <ToolStep key={m.id} entry={entry} onToggle={() => onToggleTool(m.callId)} />;
			}
			case 'approval': {
				const entry: ApprovalEntry | undefined = approvals[m.callId];
				if (!entry) return <span key={m.id} />;
				return <ApprovalCard key={m.id} entry={entry} onResolve={() => onResolveApproval(m.callId)} />;
			}
			case 'diff': {
				const entry: DiffEntry | undefined = diffs[m.callId];
				if (!entry) return <span key={m.id} />;
				return <DiffCard key={m.id} entry={entry} onToggle={() => onToggleDiff(m.callId)} />;
			}
			case 'compaction':
				return <CompactionStep key={m.id} active={m.active} />;
			default:
				return <span key={m.id} />;
		}
	};

	for (const m of messages) {
		if (m.kind === 'user') {
			if (turnOpen) {
				groups.push(
					<div className="turn" key={`turn-${turnKey}`}>
						{turnItems}
					</div>
				);
				turnItems = [];
				turnOpen = false;
			}
			groups.push(<UserMessage key={m.id} text={m.text} onDelete={() => onDeleteUser(m.id)} />);
		} else {
			if (!turnOpen) {
				turnOpen = true;
				turnKey = m.turn;
			}
			turnItems.push(renderItem(m));
		}
	}
	if (turnOpen) {
		groups.push(
			<div className="turn" key={`turn-${turnKey}`}>
				{turnItems}
			</div>
		);
	}

	const placeholder = messages.length === 0 ? (
		<div className="placeholder">
			<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor">
				<path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z" />
			</svg>
			<div className="placeholder-title">欢迎使用云效 Agent</div>
			输入消息开始对话，用 @ 引用文件
		</div>
	) : null;

	return (
		<div id="messages" ref={messagesRef} aria-live="polite" onScroll={handleScroll}>
			{placeholder}
			{groups}
		</div>
	);
}
