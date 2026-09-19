/**
 * 决策模型（Decision model）：TypeSafe System One 一类的「判定型」模型，
 * 不生成文本，只对给定状态逐条给出选择。
 *
 * 真源是 system_settings 的 `decision_models`，JSON 形如：
 * `{ "models": [{ id, name, baseUrl, model, apiKey, enabled }] }`。
 * 该配置独立于代码库设置：代码库只保存选中的决策模型 id，其它功能可复用同一份配置。
 * Rust 侧（native/src/api/jev.rs）按同一份 JSON 解析，字段名必须保持 camelCase 一致。
 */

export const DECISION_MODELS_SETTING_NAME = "Decision models";
export const DECISION_MODELS_SETTING_CODE = "decision_models";

/** 官方 TypeSafe System One 端点（Base URL 留空时 Rust 也回落到该地址）。 */
export const DEFAULT_DECISION_MODEL_BASE_URL = "https://api.typesafe.ai/v1";
/** 官方默认模型名。 */
export const DEFAULT_DECISION_MODEL_MODEL = "jev-latest";
/** 新建决策模型时的默认名称。 */
export const DEFAULT_DECISION_MODEL_NAME = "Jev (TypeSafe)";

/** 单个决策模型配置。 */
export type DecisionModelConfig = {
  id: string;
  name: string;
  baseUrl: string;
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

/** 新建决策模型的默认值（预填官方 TypeSafe 端点）。 */
export const createDecisionModel = (
  name = DEFAULT_DECISION_MODEL_NAME,
): DecisionModelConfig => ({
  id: createDecisionModelId(),
  name,
  baseUrl: DEFAULT_DECISION_MODEL_BASE_URL,
  model: DEFAULT_DECISION_MODEL_MODEL,
  apiKey: "",
  enabled: true,
});

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

  return {
    id: toText(value.id) || createDecisionModelId(),
    name: name || model,
    baseUrl: toText(value.baseUrl) || DEFAULT_DECISION_MODEL_BASE_URL,
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
      baseUrl: model.baseUrl.trim(),
      model: model.model.trim(),
      apiKey: model.apiKey.trim(),
    })),
  });

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
