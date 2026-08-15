/**
 * 会话级 Token 累计条组件。
 *
 * 职责：展示会话累计 token 总量与四类拆分（思考/工具/回复/输入/上下文）
 * 及缓存输入明细；估算项带"约"，与迁移前展示口径一致。
 */
import { type JSX } from 'react';
import type { SessionTokenPayload } from '../../protocol';
import { formatSessionTokenUsage } from '../../utils/format';

/** Token 条属性。 */
export interface SessionTokenBarProps {
	/** 会话累计 token 数据（null 时不展示） */
	payload: SessionTokenPayload | null;
}

/** 会话级 Token 累计条。 */
export function SessionTokenBar({ payload }: SessionTokenBarProps): JSX.Element | null {
	if (!payload) return null;
	const { total, items, title } = formatSessionTokenUsage(payload);
	return (
		<div id="sessionTokenBar" title={title}>
			<span>会话 Token</span>
			<span className="stb-total">{total}</span>
			<span className="stb-items">
				{items.map((it) => (
					<span className="stb-item" key={it.label}>
						<span className="stb-label">{it.label}</span> <span className="stb-val">{it.val}</span>
					</span>
				))}
			</span>
		</div>
	);
}
