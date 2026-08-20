/**
 * 全局模型配置存储。
 *
 * 职责：将可公开的多模型配置保存到 `.yunForce/modelConfig/models.json`，
 * 并将每个模型的 API Key 保存在 VS Code SecretStorage，绝不下发到 Webview。
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	ANTHROPIC_DEFAULT_BASE_URL,
	DEFAULT_MODEL_CONFIG,
	normalizeRuntime,
	type ModelConfig,
	type ModelRuntime,
} from './modelConfig';
import type { ReasoningLevel } from '../llm/types';
import * as logger from '../logger';

/** 新建模型默认写入的推理强度档位（中档）。 */
export const DEFAULT_REASONING_LEVEL: ReasoningLevel = 'medium';

/** 合法推理强度档位集合（仅 low/medium/high）。 */
const VALID_REASONING_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

/**
 * 校验推理强度档位：仅接受 'low' | 'medium' | 'high'，其余返回 false。
 * @param raw 待校验值
 * @returns 是否为合法三档之一
 */
export function isReasoningLevel(raw: unknown): raw is ReasoningLevel {
	return typeof raw === 'string' && VALID_REASONING_LEVELS.has(raw);
}

/** 设置页提交的模型字段（带 id 时更新现有模型，否则新增）。 */
export interface ModelSettingsInput {
	/** 待编辑模型 ID；缺省时创建模型。 */
	readonly id?: string;
	/** Provider ID（如 "openai"）。 */
	readonly provider: string;
	/** 模型名称（必填）。 */
	readonly model: string;
	/** API 地址。 */
	readonly baseURL: string;
	/** 温度参数（0-2）。 */
	readonly temperature: number;
	/** 最大输出 token 数（>=1）。 */
	readonly maxTokens: number;
	/** 模型最大上下文 token 数。 */
	readonly maxContextTokens?: number;
	/** 模型运行时选择。 */
	readonly runtime?: ModelRuntime;
	/** 可选的新 API Key：非空才更新 SecretStorage。 */
	readonly apiKey?: string;
	/** 用户显式选择的推理强度三档（可选；缺省新建模型写入中档）。 */
	readonly reasoningEffort?: ReasoningLevel;
}

/** 模型列表单项（不含 API Key 明文）。 */
export interface ModelProfileView {
	/** 模型配置唯一 ID。 */
	readonly id: string;
	/** Provider ID。 */
	readonly provider: string;
	/** 模型名称。 */
	readonly model: string;
	/** API 地址。 */
	readonly baseURL: string;
	/** 温度参数。 */
	readonly temperature: number;
	/** 最大输出 token 数。 */
	readonly maxTokens: number;
	/** 模型最大上下文 token 数。 */
	readonly maxContextTokens: number;
	/** 模型运行时选择。 */
	readonly runtime: ModelRuntime;
	/** 是否可作为默认模型使用。 */
	readonly enabled: boolean;
	/** 是否为当前对话使用的默认模型。 */
	readonly isDefault: boolean;
	/** API Key 是否已配置（不含密钥明文）。 */
	readonly apiKeyConfigured: boolean;
	/** 该模型记忆的推理强度三档（缺失时未显式设置）。 */
	readonly reasoningEffort?: ReasoningLevel;
}

/** 设置页展示视图；顶层字段保留为当前默认模型，兼容已有表单与旧 Webview。 */
export interface ModelSettingsView {
	/** 当前默认模型 ID；尚未配置时缺省。 */
	readonly defaultModelId?: string;
	/** 已保存模型列表。 */
	readonly models?: readonly ModelProfileView[];
	/** Provider ID。 */
	readonly provider: string;
	/** 模型名称。 */
	readonly model: string;
	/** API 地址。 */
	readonly baseURL: string;
	/** 温度参数。 */
	readonly temperature: number;
	/** 最大输出 token 数。 */
	readonly maxTokens: number;
	/** 模型最大上下文 token 数。 */
	readonly maxContextTokens: number;
	/** 模型运行时选择。 */
	readonly runtime?: ModelRuntime;
	/** API Key 是否已配置（不含密钥明文）。 */
	readonly apiKeyConfigured: boolean;
	/** 当前默认模型记忆的推理强度三档（缺失时未显式设置）。 */
	readonly reasoningEffort?: ReasoningLevel;
}

/** 旧版 globalState 中的非敏感字段键名，仅用于一次性迁移。 */
const LEGACY_MODEL_STATE_KEY = 'yunxiaoAgent.modelConfig';
/** 旧版单模型 API Key 键名，仅用于一次性迁移。 */
const LEGACY_API_KEY_SECRET_KEY = 'yunxiaoAgent.model.apiKey';
/** 每个模型 API Key 的 SecretStorage 键前缀。 */
const API_KEY_SECRET_PREFIX = 'yunxiaoAgent.model.apiKey.';
/** 配置文件相对全局 `.yunForce` 配置目录的路径。 */
const MODEL_CONFIG_RELATIVE_PATH = path.join('modelConfig', 'models.json');
/** 旧版配置文件相对工作区根目录的路径。 */
const LEGACY_WORKSPACE_MODEL_CONFIG_RELATIVE_PATH = path.join('.yunForce', 'modelConfig', 'models.json');
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;
const MAX_TOKENS_MIN = 1;
const MAX_TOKENS_MAX = 128_000;
const MAX_CONTEXT_TOKENS_MIN = 1_024;
const MAX_CONTEXT_TOKENS_MAX = 10_000_000;
const SUPPORTED_PROVIDERS: readonly string[] = ['openai', 'anthropic'];

/** 旧版 globalState 持久化结构。 */
interface LegacyStoredModelFields {
	readonly provider?: string;
	readonly model?: string;
	readonly baseURL?: string;
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly maxContextTokens?: number;
	readonly runtime?: unknown;
}

/** 文件中保存的非敏感模型数据。 */
interface StoredModelProfile extends LegacyStoredModelFields {
	readonly id: string;
	readonly provider: string;
	readonly model: string;
	readonly baseURL: string;
	readonly temperature: number;
	readonly maxTokens: number;
	readonly maxContextTokens: number;
	readonly runtime: ModelRuntime;
	readonly enabled: boolean;
	/** 该模型显式选择的推理强度三档（可选；旧档案缺失时保持未设置）。 */
	readonly reasoningEffort?: ReasoningLevel;
}

/** 文件中保存的多模型容器。 */
interface StoredModelDocument {
	readonly version: 1;
	readonly defaultModelId?: string;
	readonly models: readonly StoredModelProfile[];
}

/**
 * 校验设置页提交的模型字段。
 *
 * @param input 用户提交的模型字段
 * @returns 校验错误消息；合法时为 null
 */
export function validateModelSettings(input: ModelSettingsInput): string | null {
	if (!input.model || !input.model.trim()) {return '模型名称不能为空';}
	if (!SUPPORTED_PROVIDERS.includes(input.provider)) {return `不支持的模型服务: ${input.provider}（仅支持 ${SUPPORTED_PROVIDERS.join('、')}）`;}
	if (input.provider === 'anthropic' && normalizeRuntime(input.runtime) === 'legacy') {return 'Anthropic 模型仅支持 ai-sdk 运行时，不支持 legacy 手写 OpenAI 运行时';}
	if (input.baseURL) {
		try {
			const url = new URL(input.baseURL);
			if (url.protocol !== 'http:' && url.protocol !== 'https:') {return 'API 地址必须是 http(s) 地址';}
		} catch {
			return 'API 地址格式不合法';
		}
	}
	if (typeof input.temperature !== 'number' || Number.isNaN(input.temperature) || input.temperature < TEMPERATURE_MIN || input.temperature > TEMPERATURE_MAX) {return `温度参数需在 ${TEMPERATURE_MIN}-${TEMPERATURE_MAX} 之间`;}
	if (typeof input.maxTokens !== 'number' || Number.isNaN(input.maxTokens) || input.maxTokens < MAX_TOKENS_MIN || input.maxTokens > MAX_TOKENS_MAX) {return `最大输出 token 数需在 ${MAX_TOKENS_MIN}-${MAX_TOKENS_MAX} 之间`;}
	const maxContextTokens = input.maxContextTokens ?? DEFAULT_MODEL_CONFIG.maxContextTokens;
	if (typeof maxContextTokens !== 'number' || Number.isNaN(maxContextTokens) || maxContextTokens < MAX_CONTEXT_TOKENS_MIN || maxContextTokens > MAX_CONTEXT_TOKENS_MAX) {return `最大上下文 token 数需在 ${MAX_CONTEXT_TOKENS_MIN}-${MAX_CONTEXT_TOKENS_MAX} 之间`;}
	if (input.maxTokens >= maxContextTokens) {return '最大输出 token 数必须小于最大上下文 token 数';}
	return null;
}

/** 全局多模型配置存储服务。 */
export class ModelConfigStore {
	/** 配置文件绝对路径。 */
	private readonly _filePath: string;
	/** 旧版工作区配置文件绝对路径。 */
	private readonly _legacyWorkspaceFilePath?: string;

	/**
	 * 创建存储服务。
	 *
	 * @param context VS Code 扩展上下文（用于迁移与 SecretStorage）
	 * @param globalConfigRoot 全局 `.yunForce` 配置目录；缺省时使用用户主目录下的 `.yunForce`
	 * @param legacyWorkspaceRoot 当前工作区根目录；仅用于首次迁移旧版模型档案
	 */
	constructor(private readonly context: vscode.ExtensionContext, globalConfigRoot = path.join(os.homedir(), '.yunForce'), legacyWorkspaceRoot?: string) {
		this._filePath = path.join(globalConfigRoot, MODEL_CONFIG_RELATIVE_PATH);
		this._legacyWorkspaceFilePath = legacyWorkspaceRoot
			? path.join(legacyWorkspaceRoot, LEGACY_WORKSPACE_MODEL_CONFIG_RELATIVE_PATH)
			: undefined;
	}

	/**
	 * 读取当前默认模型的完整配置。
	 *
	 * @returns Provider 使用的模型配置
	 */
	async getModelConfig(): Promise<ModelConfig> {
		const document = await this._readDocument();
		const profile = document.models.find((item) => item.id === document.defaultModelId && item.enabled);
		if (!profile) {return { ...DEFAULT_MODEL_CONFIG };}
		const apiKey = await this.context.secrets.get(this._apiKeySecretKey(profile.id));
		const config = this._toModelConfig(profile, apiKey ?? '');
		logger.log(`[ModelConfigStore] 读取默认模型 id=${profile.id} model=${profile.model} apiKey=${apiKey ? '已配置' : '未配置'}`);
		return config;
	}

	/**
	 * 获取设置页快照，所有 API Key 仅以布尔状态暴露。
	 *
	 * @returns 多模型设置页视图
	 */
	async getSettingsView(): Promise<ModelSettingsView> {
		const document = await this._readDocument();
		const models = await Promise.all(document.models.map(async (profile) => ({
			...profile,
			isDefault: profile.id === document.defaultModelId,
			apiKeyConfigured: Boolean(await this.context.secrets.get(this._apiKeySecretKey(profile.id))),
		})));
		const selected = document.models.find((item) => item.id === document.defaultModelId) ?? document.models[0];
		return {
			defaultModelId: document.defaultModelId,
			models,
			provider: selected?.provider ?? DEFAULT_MODEL_CONFIG.provider,
			model: selected?.model ?? DEFAULT_MODEL_CONFIG.model,
			baseURL: selected?.baseURL ?? DEFAULT_MODEL_CONFIG.baseURL,
			temperature: selected?.temperature ?? DEFAULT_MODEL_CONFIG.temperature,
			maxTokens: selected?.maxTokens ?? DEFAULT_MODEL_CONFIG.maxTokens,
			maxContextTokens: selected?.maxContextTokens ?? DEFAULT_MODEL_CONFIG.maxContextTokens,
			runtime: selected?.runtime ?? DEFAULT_MODEL_CONFIG.runtime,
			apiKeyConfigured: selected ? Boolean(await this.context.secrets.get(this._apiKeySecretKey(selected.id))) : false,
			...(selected?.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
		};
	}

	/**
	 * 新增或更新模型。首个模型会自动设为默认模型。
	 *
	 * @param input 设置页提交的模型字段
	 * @returns 当前默认模型完整配置
	 */
	async save(input: ModelSettingsInput): Promise<ModelConfig> {
		const error = validateModelSettings(input);
		if (error) {
			logger.error(`[ModelConfigStore] 拒绝保存无效模型配置: ${error}`);
			throw new Error(error);
		}
		const document = await this._readDocument();
		const existing = input.id ? document.models.find((item) => item.id === input.id) : undefined;
		if (input.id && !existing) {throw new Error('未找到要编辑的模型配置');}
		const id = existing?.id ?? this._newId(document.models);
		const defaultBaseURL = input.provider === 'anthropic' ? ANTHROPIC_DEFAULT_BASE_URL : DEFAULT_MODEL_CONFIG.baseURL;
		const profile: StoredModelProfile = {
			id,
			provider: input.provider,
			model: input.model.trim(),
			baseURL: input.baseURL || defaultBaseURL,
			temperature: input.temperature,
			maxTokens: input.maxTokens,
			maxContextTokens: input.maxContextTokens ?? DEFAULT_MODEL_CONFIG.maxContextTokens ?? 262144,
			runtime: normalizeRuntime(input.runtime),
			enabled: existing?.enabled ?? true,
			// 新建模型默认中档；编辑其他字段时保留既有档位，除非本次显式携带 reasoningEffort
			reasoningEffort: input.reasoningEffort ?? existing?.reasoningEffort ?? (existing ? undefined : DEFAULT_REASONING_LEVEL),
		};
		const models = existing ? document.models.map((item) => item.id === id ? profile : item) : [...document.models, profile];
		await this._writeDocument({ version: 1, defaultModelId: document.defaultModelId ?? id, models });
		if (input.apiKey?.trim()) {
			await this.context.secrets.store(this._apiKeySecretKey(id), input.apiKey.trim());
			logger.log(`[ModelConfigStore] API Key 已更新 modelId=${id}（SecretStorage）`);
		}
		logger.log(`[ModelConfigStore] 模型配置已保存 id=${id} model=${profile.model} path=${this._filePath}`);
		return this.getModelConfig();
	}

	/**
	 * 设置默认模型；默认模型必须已启用。
	 *
	 * @param modelId 模型 ID
	 * @returns 当前默认模型完整配置
	 */
	async setDefaultModel(modelId: string): Promise<ModelConfig> {
		const document = await this._readDocument();
		const profile = document.models.find((item) => item.id === modelId);
		if (!profile) {throw new Error('未找到要设为默认的模型');}
		if (!profile.enabled) {throw new Error('请先启用该模型，再设为默认模型');}
		await this._writeDocument({ ...document, defaultModelId: modelId });
		logger.log(`[ModelConfigStore] 默认模型已切换 id=${modelId} model=${profile.model}`);
		return this.getModelConfig();
	}

	/**
	 * 为指定模型持久化推理强度三档。目标模型必须是当前默认且已启用，非法档位被拒绝。
	 *
	 * @param modelId 模型 ID
	 * @param level 推理强度三档（low/medium/high）
	 * @returns 当前默认模型完整配置
	 */
	async setReasoningEffort(modelId: string, level: ReasoningLevel): Promise<ModelConfig> {
		if (!isReasoningLevel(level)) {
			logger.error(`[ModelConfigStore] 拒绝非法推理强度档位 modelId=${modelId} level=${String(level)}`);
			throw new Error('推理强度档位不合法（仅支持 low/medium/high）');
		}
		const document = await this._readDocument();
		const profile = document.models.find((item) => item.id === modelId);
		if (!profile) {
			logger.error(`[ModelConfigStore] 拒绝设置推理强度，目标模型不存在 modelId=${modelId}`);
			throw new Error('未找到要设置推理强度的模型');
		}
		if (!profile.enabled || document.defaultModelId !== modelId) {
			logger.error(`[ModelConfigStore] 拒绝设置推理强度，目标模型非当前默认或未启用 modelId=${modelId} enabled=${profile.enabled}`);
			throw new Error('只能为当前默认且已启用的模型设置推理强度');
		}
		await this._writeDocument({
			...document,
			models: document.models.map((item) => item.id === modelId ? { ...item, reasoningEffort: level } : item),
		});
		logger.log(`[ModelConfigStore] 推理强度已持久化 modelId=${modelId} level=${level}`);
		return this.getModelConfig();
	}

	/**
	 * 启用或禁用模型。默认模型不可直接禁用，避免后续对话没有可用模型。
	 *
	 * @param modelId 模型 ID
	 * @param enabled 是否启用
	 * @returns 操作完成后的设置页视图
	 */
	async setModelEnabled(modelId: string, enabled: boolean): Promise<ModelSettingsView> {
		const document = await this._readDocument();
		const profile = document.models.find((item) => item.id === modelId);
		if (!profile) {throw new Error('未找到要更新的模型');}
		if (!enabled && document.defaultModelId === modelId) {throw new Error('默认模型不能直接禁用，请先将其他已启用模型设为默认');}
		await this._writeDocument({ ...document, models: document.models.map((item) => item.id === modelId ? { ...item, enabled } : item) });
		logger.log(`[ModelConfigStore] 模型启用状态已更新 id=${modelId} enabled=${enabled}`);
		return this.getSettingsView();
	}

	/**
	 * 删除非默认模型及其安全存储的密钥。
	 *
	 * @param modelId 模型 ID
	 * @returns 操作完成后的设置页视图
	 */
	async deleteModel(modelId: string): Promise<ModelSettingsView> {
		const document = await this._readDocument();
		if (!document.models.some((item) => item.id === modelId)) {throw new Error('未找到要删除的模型');}
		if (document.defaultModelId === modelId) {throw new Error('默认模型不能直接删除，请先将其他已启用模型设为默认');}
		await this._writeDocument({ ...document, models: document.models.filter((item) => item.id !== modelId) });
		await this.context.secrets.delete(this._apiKeySecretKey(modelId));
		logger.log(`[ModelConfigStore] 模型已删除 id=${modelId}`);
		return this.getSettingsView();
	}

	/**
	 * 读取文件；首次读取时迁移旧 globalState 单模型配置。
	 *
	 * @returns 多模型持久化文档
	 */
	private async _readDocument(): Promise<StoredModelDocument> {
		try {
			const raw = await fs.readFile(this._filePath, 'utf8');
			const parsed = JSON.parse(raw) as StoredModelDocument;
			if (parsed.version === 1 && Array.isArray(parsed.models)) {
				return {
					...parsed,
					models: parsed.models.map((profile) => ({
						...profile,
						maxContextTokens: typeof profile.maxContextTokens === 'number'
							? profile.maxContextTokens
							: DEFAULT_MODEL_CONFIG.maxContextTokens,
					})),
				};
			}
			throw new Error('格式不受支持');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				const migrated = await this._migrateWorkspaceConfig();
				if (migrated) {return migrated;}
			} else {
				logger.error(`[ModelConfigStore] 读取模型配置失败 path=${this._filePath}: ${error instanceof Error ? error.message : String(error)}`);
			}
			return this._migrateLegacyConfig();
		}
	}

	/**
	 * 首次读取全局配置时迁移当前工作区的旧版模型档案。
	 *
	 * @returns 成功迁移时返回模型文档；没有可迁移文件时返回 undefined
	 */
	private async _migrateWorkspaceConfig(): Promise<StoredModelDocument | undefined> {
		if (!this._legacyWorkspaceFilePath) {return undefined;}
		try {
			const raw = await fs.readFile(this._legacyWorkspaceFilePath, 'utf8');
			const document = JSON.parse(raw) as StoredModelDocument;
			if (document.version !== 1 || !Array.isArray(document.models)) {
				throw new Error('格式不受支持');
			}
			await this._writeDocument(document);
			logger.log(`[ModelConfigStore] 已迁移工作区模型配置 source=${this._legacyWorkspaceFilePath} target=${this._filePath} models=${document.models.length}`);
			return document;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				logger.error(`[ModelConfigStore] 迁移工作区模型配置失败 source=${this._legacyWorkspaceFilePath}: ${error instanceof Error ? error.message : String(error)}`);
			}
			return undefined;
		}
	}

	/**
	 * 将历史 globalState 单模型配置迁移到全局配置文件。
	 *
	 * @returns 迁移后的文档；没有历史配置时返回空文档
	 */
	private async _migrateLegacyConfig(): Promise<StoredModelDocument> {
		const legacy = this.context.globalState.get<LegacyStoredModelFields>(LEGACY_MODEL_STATE_KEY);
		if (!legacy?.model?.trim()) {return { version: 1, models: [] };}
		const id = this._newId([]);
		const profile: StoredModelProfile = {
			id, provider: legacy.provider || DEFAULT_MODEL_CONFIG.provider, model: legacy.model.trim(), baseURL: legacy.baseURL || DEFAULT_MODEL_CONFIG.baseURL,
			temperature: typeof legacy.temperature === 'number' ? legacy.temperature : DEFAULT_MODEL_CONFIG.temperature,
			maxTokens: typeof legacy.maxTokens === 'number' ? legacy.maxTokens : DEFAULT_MODEL_CONFIG.maxTokens,
			maxContextTokens: typeof legacy.maxContextTokens === 'number' ? legacy.maxContextTokens : DEFAULT_MODEL_CONFIG.maxContextTokens ?? 262144,
			runtime: normalizeRuntime(legacy.runtime), enabled: true,
		};
		const document: StoredModelDocument = { version: 1, defaultModelId: id, models: [profile] };
		await this._writeDocument(document);
		const legacyKey = await this.context.secrets.get(LEGACY_API_KEY_SECRET_KEY);
		if (legacyKey) {await this.context.secrets.store(this._apiKeySecretKey(id), legacyKey);}
		await this.context.globalState.update(LEGACY_MODEL_STATE_KEY, undefined);
		logger.log(`[ModelConfigStore] 已迁移旧版模型配置到 path=${this._filePath} model=${profile.model}`);
		return document;
	}

	/**
	 * 写入模型配置文件。
	 *
	 * @param document 待持久化文档
	 * @returns Promise<void>
	 */
	private async _writeDocument(document: StoredModelDocument): Promise<void> {
		await fs.mkdir(path.dirname(this._filePath), { recursive: true });
		await fs.writeFile(this._filePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
	}

	/**
	 * 生成配置 ID。
	 *
	 * @param models 现有模型
	 * @returns 未冲突的 ID
	 */
	private _newId(models: readonly StoredModelProfile[]): string {
		let id = `model-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		while (models.some((item) => item.id === id)) {id = `${id}-1`;}
		return id;
	}

	/**
	 * 获取模型密钥键名。
	 *
	 * @param modelId 模型 ID
	 * @returns SecretStorage 键名
	 */
	private _apiKeySecretKey(modelId: string): string { return `${API_KEY_SECRET_PREFIX}${modelId}`; }

	/**
	 * 将存储模型转换为 Provider 配置。
	 *
	 * @param profile 存储模型
	 * @param apiKey 对应密钥
	 * @returns 完整模型配置
	 */
	private _toModelConfig(profile: StoredModelProfile, apiKey: string): ModelConfig {
		return {
			provider: profile.provider,
			model: profile.model,
			apiKey,
			baseURL: profile.baseURL,
			temperature: profile.temperature,
			maxTokens: profile.maxTokens,
			maxContextTokens: profile.maxContextTokens ?? DEFAULT_MODEL_CONFIG.maxContextTokens,
			runtime: profile.runtime,
			...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
		};
	}
}
