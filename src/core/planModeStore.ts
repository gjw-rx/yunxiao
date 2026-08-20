/**
 * Plan 模式状态服务 - 会话级 Plan 阶段（规划/审阅/执行）的读取、合法转换、
 * 持久化与类型化事件广播。所有阶段变更统一经此服务完成，保证模型可见边界、
 * 路由兜底与 UI 状态一致。
 */
import type { EventBus } from './eventBus';
import type { SessionFileStore } from '../memory/sessionFileStore';
import type { PlanModeChangePayload, PlanStage, SessionPlanState } from '../memory/planTypes';
import { PLAN_TRANSITIONS } from '../memory/planTypes';
import type { ToolSchema } from './types';
import * as logger from '../logger';

/** 会话级 Plan 模式服务。 */
export class SessionPlanModeStore {
	/**
	 * @param fileStore 同 workspace 的会话文件存储（负责原子持久化）。
	 * @param eventBus 用于向界面广播 plan_mode_change 状态事件。
	 */
	constructor(
		private readonly fileStore: SessionFileStore,
		private readonly eventBus: EventBus
	) {}

	/** 读取会话当前 Plan 状态；缺失或非法值回退 normal。 @param sessionId 会话 ID。 @returns Plan 状态。 */
	getState(sessionId: string): SessionPlanState {
		return this.fileStore.getPlanState(sessionId);
	}

	/**
	 * 执行合法状态转换：校验来源阶段、持久化、广播 plan_mode_change 事件并记录关键日志。
	 * 转换的业务前置条件（Agent 空闲、活跃 Todo 校验等）由调用方（LocalSessionManager）负责。
	 * @param sessionId 会话 ID。
	 * @param to 目标阶段。
	 * @returns 转换后的 Plan 状态。
	 * @throws 非法转换（来源阶段不匹配）时抛错，不改变状态、不发事件。
	 */
	transition(sessionId: string, to: PlanStage): SessionPlanState {
		const prev = this.getState(sessionId);
		const allowed = PLAN_TRANSITIONS.some(
			([fromStages, target]) => target === to && fromStages.includes(prev.stage)
		);
		if (!allowed) {
			logger.error(`[SessionPlanModeStore] 非法状态转换已拒绝 sessionId=${sessionId} ${prev.stage} -> ${to}`);
			throw new Error(`非法 Plan 状态转换: ${prev.stage} -> ${to} sessionId=${sessionId}`);
		}

		// 草案标记规则：进入规划重置（继续规划保留）；进入审阅视为已创建草案；
		// 确认执行沿用；退出任何阶段重置。
		let draftCreated: boolean;
		switch (to) {
			case 'planning':
				draftCreated = prev.stage === 'review' ? prev.draftCreated : false;
				break;
			case 'review':
				draftCreated = true;
				break;
			case 'executing':
				draftCreated = prev.draftCreated;
				break;
			default:
				draftCreated = false;
		}

		const next: SessionPlanState = { stage: to, draftCreated };
		this.fileStore.setPlanState(sessionId, next);
		const payload: PlanModeChangePayload = { from: prev.stage, to, draftCreated };
		this.eventBus.emit({ type: 'plan_mode_change', sessionId, payload });
		logger.log(
			`[SessionPlanModeStore] 状态转换 sessionId=${sessionId} ${prev.stage} -> ${to} draftCreated=${draftCreated}`
		);
		return next;
	}

	/**
	 * 标记当前规划 run 已成功创建 Todo 草案（仅 planning 阶段生效，防止误标 executing 阶段）。
	 * 退出时据此决定是否清空草案，避免误删旧 Todo 快照。
	 * @param sessionId 会话 ID。
	 * @returns 无返回值。
	 */
	markDraftCreated(sessionId: string): void {
		const state = this.getState(sessionId);
		if (state.stage !== 'planning' || state.draftCreated) {
			return;
		}
		this.fileStore.setPlanState(sessionId, { ...state, draftCreated: true });
		logger.log(`[SessionPlanModeStore] 标记本轮已创建草案 sessionId=${sessionId}`);
	}

	/**
	 * 按会话与工具权限判定工具可用性的统一策略（单一事实来源）。
	 * planning/review 仅允许 read 权限工具（todo_write 因声明 read 自然保留）；
	 * normal/executing 允许完整工具集。
	 * @param sessionId 会话 ID。
	 * @param schema 工具 schema（只需 permissions）。
	 * @returns 是否允许该工具在当前会话的 Plan 阶段使用。
	 */
	isToolAllowed(sessionId: string, schema: Pick<ToolSchema, 'permissions'>): boolean {
		const stage = this.getState(sessionId).stage;
		if (stage === 'planning' || stage === 'review') {
			return schema.permissions === 'read';
		}
		return true;
	}
}
