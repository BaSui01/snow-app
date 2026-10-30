/**
 * 决策模型（Decision model）：TypeSafe System One / OpenAI Decisions 一类的
 * 「判定型」模型，不生成文本，只对给定状态逐条给出选择。
 *
 * 真源是 system_settings 的 `decision_models`，JSON 形如：
 * `{ "models": [{ id, name, provider, baseUrl, baseUrlMode, model, apiKey, enabled }] }`。
 * 该配置独立于代码库设置：代码库只保存选中的决策模型 id，其它功能可复用同一份配置。
 * Rust 侧（native/src/api/decision_model.rs）按同一份 JSON 解析，字段名保持 camelCase 一致。
 */

export const DECISION_MODELS_SETTING_NAME = "Decision models";
export const DECISION_MODELS_SETTING_CODE = "decision_models";

export type DecisionModelProvider = "typesafe" | "openai";

export const DECISION_MODEL_PROVIDER_TYPESAFE: DecisionModelProvider =
  "typesafe";
export const DECISION_MODEL_PROVIDER_OPENAI: DecisionModelProvider = "openai";
export const DEFAULT_DECISION_MODEL_PROVIDER: DecisionModelProvider =
  DECISION_MODEL_PROVIDER_TYPESAFE;

/** 官方 TypeSafe System One 端点（Base URL 留空时 Rust 也回落到该地址）。 */
export const DEFAULT_DECISION_MODEL_BASE_URL = "https://api.typesafe.ai/v1";
/** 官方默认模型名。 */
export const DEFAULT_DECISION_MODEL_MODEL = "jev-latest";
/** 新建 TypeSafe 决策模型时的默认名称。 */
export const DEFAULT_DECISION_MODEL_NAME = "Jev (TypeSafe)";

/** 官方 OpenAI Decisions 端点（Base URL 留空时 Rust 也回落到该地址）。 */
export const DEFAULT_OPENAI_DECISION_MODEL_BASE_URL =
  "https://api.openai.com/v1";
/** OpenAI Decisions 默认模型名（仍可自由填写，不设白名单）。 */
export const DEFAULT_OPENAI_DECISION_MODEL_MODEL = "gpt-6-luna";
/** 新建 OpenAI Decisions 决策模型时的默认名称。 */
export const DEFAULT_OPENAI_DECISION_MODEL_NAME = "OpenAI Decisions";

export type DecisionModelBaseUrlMode = "auto" | "custom";

export const DECISION_MODEL_BASE_URL_MODE_AUTO: DecisionModelBaseUrlMode =
  "auto";
export const DECISION_MODEL_BASE_URL_MODE_CUSTOM: DecisionModelBaseUrlMode =
  "custom";
export const DECISION_MODEL_CUSTOM_BASE_URL_EXAMPLE =
  "https://openrouter.ai/api/alpha/decisions";

/** 单个决策模型配置。 */
export type DecisionModelConfig = {
  id: string;
  name: string;
  provider: DecisionModelProvider;
  baseUrl: string;
  baseUrlMode: DecisionModelBaseUrlMode;
  model: string;
  apiKey: string;
  enabled: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** 生成决策模型 id（时间戳 + 随机后缀，不依赖 crypto）。 */
export const createDecisionModelId = (): string =>
  `dm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const normalizeDecisionModelProvider = (
  value: unknown,
): DecisionModelProvider =>
  toText(value) === DECISION_MODEL_PROVIDER_OPENAI
    ? DECISION_MODEL_PROVIDER_OPENAI
    : DECISION_MODEL_PROVIDER_TYPESAFE;

/** provider 对应的默认 Base URL（新建与切换 provider 时使用）。 */
export const decisionModelDefaultBaseUrl = (
  provider: DecisionModelProvider,
): string =>
  provider === DECISION_MODEL_PROVIDER_OPENAI
    ? DEFAULT_OPENAI_DECISION_MODEL_BASE_URL
    : DEFAULT_DECISION_MODEL_BASE_URL;

/** provider 对应的默认模型名。 */
export const decisionModelDefaultModel = (
  provider: DecisionModelProvider,
): string =>
  provider === DECISION_MODEL_PROVIDER_OPENAI
    ? DEFAULT_OPENAI_DECISION_MODEL_MODEL
    : DEFAULT_DECISION_MODEL_MODEL;

/** provider 对应的新建默认名称。 */
export const decisionModelDefaultName = (
  provider: DecisionModelProvider,
): string =>
  provider === DECISION_MODEL_PROVIDER_OPENAI
    ? DEFAULT_OPENAI_DECISION_MODEL_NAME
    : DEFAULT_DECISION_MODEL_NAME;

/** 新建决策模型的默认值（按 provider 预填端点与模型名）。 */
export const createDecisionModel = (
  provider: DecisionModelProvider = DEFAULT_DECISION_MODEL_PROVIDER,
  name = decisionModelDefaultName(provider),
): DecisionModelConfig => ({
  id: createDecisionModelId(),
  name,
  provider,
  baseUrl: decisionModelDefaultBaseUrl(provider),
  baseUrlMode: DECISION_MODEL_BASE_URL_MODE_AUTO,
  model: decisionModelDefaultModel(provider),
  apiKey: "",
  enabled: true,
});

export const normalizeDecisionModelBaseUrlMode = (
  value: unknown,
): DecisionModelBaseUrlMode =>
  toText(value) === DECISION_MODEL_BASE_URL_MODE_CUSTOM
    ? DECISION_MODEL_BASE_URL_MODE_CUSTOM
    : DECISION_MODEL_BASE_URL_MODE_AUTO;

/** 规范化单个条目；既没有名称也没有模型名的条目视为无效。 */
const normalizeDecisionModel = (value: unknown): DecisionModelConfig | null => {
  if (!isRecord(value)) {
    return null;
  }

  const name = toText(value.name);
  const model = toText(value.model);

  if (!name && !model) {
    return null;
  }

  const provider = normalizeDecisionModelProvider(value.provider);
  const baseUrlMode = normalizeDecisionModelBaseUrlMode(value.baseUrlMode);
  const baseUrl = toText(value.baseUrl);

  return {
    id: toText(value.id) || createDecisionModelId(),
    name: name || model,
    provider,
    baseUrl:
      baseUrl ||
      (baseUrlMode === DECISION_MODEL_BASE_URL_MODE_CUSTOM
        ? ""
        : decisionModelDefaultBaseUrl(provider)),
    baseUrlMode,
    model,
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    // 缺省视为启用：手写配置时无需显式写 enabled。
    enabled: value.enabled !== false,
  };
};

/** 规范化整份决策模型配置（非法输入返回空列表）。 */
const normalizeDecisionModels = (value: unknown): DecisionModelConfig[] => {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    return [];
  }

  const models: DecisionModelConfig[] = [];
  for (const item of value.models) {
    const model = normalizeDecisionModel(item);
    if (model) {
      models.push(model);
    }
  }
  return models;
};

/** 读取系统设置里的决策模型配置（未配置 / 解析失败返回空列表）。 */
export const readDecisionModelsJson = (
  value: string | null,
): DecisionModelConfig[] => {
  if (!value) {
    return [];
  }

  try {
    return normalizeDecisionModels(JSON.parse(value));
  } catch {
    return [];
  }
};

/** 序列化为系统设置存储格式（去除首尾空白）。 */
export const toDecisionModelsJson = (models: DecisionModelConfig[]): string =>
  JSON.stringify({
    models: models.map((model) => ({
      ...model,
      name: model.name.trim(),
      provider: normalizeDecisionModelProvider(model.provider),
      baseUrl: model.baseUrl.trim(),
      baseUrlMode: normalizeDecisionModelBaseUrlMode(model.baseUrlMode),
      model: model.model.trim(),
      apiKey: model.apiKey.trim(),
    })),
  });

/** 实际请求端点；规则与 Rust 侧 resolve_endpoint 逐条一致。 */
export const resolveDecisionModelEndpoint = (
  model: Pick<DecisionModelConfig, "provider" | "baseUrl" | "baseUrlMode">,
): string => {
  const baseUrl = model.baseUrl.trim().replace(/\/+$/, "");

  if (
    normalizeDecisionModelProvider(model.provider) ===
    DECISION_MODEL_PROVIDER_OPENAI
  ) {
    if (!baseUrl) {
      return `${DEFAULT_OPENAI_DECISION_MODEL_BASE_URL}/decisions`;
    }
    if (baseUrl.endsWith("/decisions")) {
      return baseUrl;
    }
    if (baseUrl.endsWith("/v1")) {
      return `${baseUrl}/decisions`;
    }
    return `${baseUrl}/v1/decisions`;
  }

  if (model.baseUrlMode === DECISION_MODEL_BASE_URL_MODE_CUSTOM) {
    return baseUrl;
  }

  if (!baseUrl) {
    return `${DEFAULT_DECISION_MODEL_BASE_URL}/systemone`;
  }

  if (baseUrl.endsWith("/systemone")) {
    return baseUrl;
  }

  if (baseUrl.endsWith("/v1")) {
    return `${baseUrl}/systemone`;
  }

  return `${baseUrl}/v1/systemone`;
};

/** 已启用的决策模型（代码库审查等场景只能选用已启用的模型）。 */
export const enabledDecisionModels = (
  models: DecisionModelConfig[],
): DecisionModelConfig[] => models.filter((model) => model.enabled);

/** 按 id 查找决策模型（不校验启用状态，用于展示）。 */
export const findDecisionModel = (
  models: DecisionModelConfig[],
  id: string,
): DecisionModelConfig | null =>
  models.find((model) => model.id === id) ?? null;

/**
 * 迁移：把旧版 codebase 设置里内联的 Jev 配置并入决策模型列表。
 * 已存在完全相同的模型（baseUrl + apiKey + model）时直接复用，避免重复条目。
 */
export const mergeLegacyDecisionModel = (
  models: DecisionModelConfig[],
  legacy: { baseUrl: string; apiKey: string; model: string },
): { models: DecisionModelConfig[]; modelId: string } => {
  const existing = models.find(
    (model) =>
      model.apiKey === legacy.apiKey &&
      model.baseUrl === legacy.baseUrl &&
      model.model === legacy.model,
  );

  if (existing) {
    return { models, modelId: existing.id };
  }

  const migrated: DecisionModelConfig = {
    ...createDecisionModel(),
    baseUrl: legacy.baseUrl || DEFAULT_DECISION_MODEL_BASE_URL,
    model: legacy.model || DEFAULT_DECISION_MODEL_MODEL,
    apiKey: legacy.apiKey,
  };

  return { models: [...models, migrated], modelId: migrated.id };
};
