/**
 * HooksConfigStore - 版本化 Hooks 私有配置 Store。
 *
 * 保存 Hooks 总开关、RTK 启用状态与可选可执行文件绝对路径；
 * 缺失配置时返回安全默认值：运行时启用、RTK 默认禁用、未指定二进制路径。
 * 存储后端抽象为 HooksConfigStorage（默认 Memento 实现），便于脱离 vscode 单测。
 */
import * as logger from '../logger';
import type { HooksConfig, HooksConfigReader } from './types';

/** Hooks 配置存储键（Memento）。 */
const HOOKS_CONFIG_KEY = 'yunxiaoAgent.hooksConfig';

/** 当前配置版本。 */
export const HOOKS_CONFIG_VERSION = 1 as const;

/** 缺失配置时的安全默认值：Hooks 运行时启用、RTK 默认禁用。 */
export const DEFAULT_HOOKS_CONFIG: HooksConfig = {
	version: HOOKS_CONFIG_VERSION,
	enabled: true,
	rtk: { enabled: false },
};

/** 配置持久化存储抽象（可注入内存实现供测试）。 */
export interface HooksConfigStorage {
	/** 读取原始持久化配置；不存在返回 undefined。 */
	get(): HooksConfig | undefined;
	/** 持久化配置。 */
	set(config: HooksConfig): Promise<void>;
}

/** 基于 vscode.Memento（globalState）的默认持久化实现。 */
export class MementoHooksConfigStorage implements HooksConfigStorage {
	/**
	 * @param memento 扩展上下文提供的全局状态（globalState）
	 */
	constructor(private readonly memento: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> | Promise<void> }) {}

	get(): HooksConfig | undefined {
		return this.memento.get<HooksConfig>(HOOKS_CONFIG_KEY);
	}

	async set(config: HooksConfig): Promise<void> {
		await this.memento.update(HOOKS_CONFIG_KEY, config);
	}
}

export class HooksConfigStore implements HooksConfigReader {
	/**
	 * @param storage 持久化存储（默认 Memento 实现）
	 */
	constructor(private readonly storage: HooksConfigStorage = new MementoHooksConfigStorage({} as never)) {}

	/**
	 * 读取当前配置：解析失败或版本不兼容时回退安全默认值并记录日志。
	 *
	 * @returns 当前生效的 Hooks 配置
	 */
	get(): HooksConfig {
		const raw = this.storage.get();
		if (!raw) {
			return { ...DEFAULT_HOOKS_CONFIG, rtk: { ...DEFAULT_HOOKS_CONFIG.rtk } };
		}
		const normalized = normalizeConfig(raw);
		if (!normalized) {
			logger.error(`[HooksConfigStore] 配置非法或版本不兼容，回退安全默认值 raw=${JSON.stringify(raw)}`);
			return { ...DEFAULT_HOOKS_CONFIG, rtk: { ...DEFAULT_HOOKS_CONFIG.rtk } };
		}
		return normalized;
	}

	/**
	 * 保存配置：先规范化与版本化，再持久化。
	 *
	 * @param input 待保存的配置（允许部分字段）
	 * @returns 持久化后的完整配置
	 */
	async save(input: Partial<HooksConfig>): Promise<HooksConfig> {
		const current = this.get();
		const next = normalizeConfig({
			version: HOOKS_CONFIG_VERSION,
			enabled: input.enabled ?? current.enabled,
			rtk: {
				enabled: input.rtk?.enabled ?? current.rtk.enabled,
				executablePath: input.rtk?.executablePath ?? current.rtk.executablePath,
			},
		});
		if (!next) {
			throw new Error('Hooks 配置非法，保存失败');
		}
		await this.storage.set(next);
		logger.log(`[HooksConfigStore] 配置已保存 enabled=${next.enabled} rtkEnabled=${next.rtk.enabled} rtkPath=${next.rtk.executablePath ? '已配置' : '未配置'}`);
		return next;
	}

	/**
	 * 重置为安全默认值（RTK 禁用）。
	 *
	 * @returns 默认配置
	 */
	async reset(): Promise<HooksConfig> {
		const next = { ...DEFAULT_HOOKS_CONFIG, rtk: { ...DEFAULT_HOOKS_CONFIG.rtk } };
		await this.storage.set(next);
		logger.log('[HooksConfigStore] 配置已重置为安全默认值');
		return next;
	}
}

/**
 * 规范化配置：校验字段类型并补全默认值；非法结构返回 undefined。
 *
 * @param raw 待校验的原始配置
 * @returns 规范化后的配置；非法时 undefined
 */
function normalizeConfig(raw: HooksConfig): HooksConfig | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const version = raw.version === HOOKS_CONFIG_VERSION ? raw.version : undefined;
	if (version === undefined) {
		return undefined;
	}
	const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_HOOKS_CONFIG.enabled;
	const rtkRaw: { enabled?: unknown; executablePath?: unknown } =
		typeof raw.rtk === 'object' && raw.rtk !== null ? raw.rtk : {};
	const rtkEnabled = typeof rtkRaw.enabled === 'boolean' ? rtkRaw.enabled : DEFAULT_HOOKS_CONFIG.rtk.enabled;
	const executablePath =
		typeof rtkRaw.executablePath === 'string' && rtkRaw.executablePath.length > 0
			? rtkRaw.executablePath
			: undefined;
	return {
		version: HOOKS_CONFIG_VERSION,
		enabled,
		rtk: { enabled: rtkEnabled, ...(executablePath ? { executablePath } : {}) },
	};
}
