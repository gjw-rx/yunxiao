/**
 * Plan 模式状态契约 - 定义会话级 Plan 模式的阶段、草案标记与持久化数据结构。
 * Plan 模式允许用户先进入只读规划状态，由模型通过 todo_write 提交结构化计划，
 * 经用户审阅确认后再恢复完整工具集执行；状态按会话持久化到会话索引。
 */

/** Plan 模式会话阶段。 */
export type PlanStage = 'normal' | 'planning' | 'review' | 'executing';

/** 会话级 Plan 状态（持久化到会话索引 planStates 字段）。 */
export interface SessionPlanState {
	/** 当前阶段。 */
	readonly stage: PlanStage;
	/** 本轮规划是否已成功创建 Todo 草案（退出时据此决定是否清空草案，防止误删旧快照）。 */
	readonly draftCreated: boolean;
}

/** sessionId -> Plan 状态的映射（会话索引可选字段，旧索引缺失时按 normal 处理）。 */
export type SessionPlanStateRecord = Record<string, SessionPlanState>;

/** Plan 模式合法状态转换集合：From 阶段集合 -> To 阶段。 */
export const PLAN_TRANSITIONS: readonly (readonly [readonly PlanStage[], PlanStage])[] = [
	[['normal'], 'planning'],
	[['planning'], 'review'],
	[['review'], 'planning'],
	[['review'], 'executing'],
	[['planning', 'review'], 'normal'],
	[['executing'], 'normal'],
];

/** 阶段中文展示名（日志与 UI 提示用）。 */
export const PLAN_STAGE_LABELS: Record<PlanStage, string> = {
	normal: '普通',
	planning: '规划中',
	review: '审阅中',
	executing: '执行中',
};

/** plan_mode_change 事件 payload：携带转换前后阶段与草案标记。 */
export interface PlanModeChangePayload {
	/** 变更前的阶段。 */
	readonly from: PlanStage;
	/** 变更后的阶段。 */
	readonly to: PlanStage;
	/** 转换后是否已创建本轮草案。 */
	readonly draftCreated: boolean;
}
