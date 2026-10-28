import type { ApiConfigRecord } from "../../../../preload";
import {
  DEFAULT_THINKING_VALUE,
  THINKING_OPTIONS_BY_METHOD,
} from "./constants";
import type { RequestMethod } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const normalizeRequestMethod = (value: unknown): RequestMethod => {
  if (value === "responses" || value === "gemini" || value === "anthropic") {
    return value;
  }

  return "chat";
};

const parseConfigJson = (configJson: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(configJson);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const readNestedString = (
  source: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
};

const readNestedBoolean = (
  source: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
};

const resolveThinkingValue = (
  thinkingConfig: Record<string, unknown>,
  valueKey: string,
): string => {
  if (readNestedBoolean(thinkingConfig, "enabled") === false) {
    return "none";
  }

  const configuredValue = readNestedString(thinkingConfig, valueKey)?.trim();
  return configuredValue || DEFAULT_THINKING_VALUE;
};

export const getThinkingValueFromConfig = (config: ApiConfigRecord): string => {
  const parsedConfig = parseConfigJson(config.configJson);
  const snowcfg = isRecord(parsedConfig.snowcfg) ? parsedConfig.snowcfg : {};
  const requestMethod = normalizeRequestMethod(
    config.requestMethod || snowcfg.requestMethod,
  );
  if (requestMethod === "anthropic") {
    const thinking = isRecord(snowcfg.thinking) ? snowcfg.thinking : {};
    return resolveThinkingValue(thinking, "effort");
  }

  if (requestMethod === "gemini") {
    const geminiThinking = isRecord(snowcfg.geminiThinking)
      ? snowcfg.geminiThinking
      : {};
    return resolveThinkingValue(geminiThinking, "thinkingLevel");
  }

  if (requestMethod === "responses") {
    const responsesReasoning = isRecord(snowcfg.responsesReasoning)
      ? snowcfg.responsesReasoning
      : {};
    return resolveThinkingValue(responsesReasoning, "effort");
  }

  const chatThinking = isRecord(snowcfg.chatThinking)
    ? snowcfg.chatThinking
    : {};
  return resolveThinkingValue(chatThinking, "reasoning_effort");
};

/**
 * 解析一次请求实际生效的思考强度：父会话（主流程）为本次发送捕获的显式
 * 覆盖值优先，但它必须属于该 Profile 请求方法支持的档位；否则回落该
 * Profile 自身配置的默认值。用于子代理 / Workflow 节点等派生运行——
 * 它们跟随父会话/会话在输入区选定的思考强度，而不是静默改用 Profile 默认。
 */
export const resolveEffectiveThinkingValue = (
  config: ApiConfigRecord,
  override: string | null | undefined,
): string => {
  const requested = override?.trim();
  if (requested) {
    const method = normalizeRequestMethod(config.requestMethod);
    const supported = THINKING_OPTIONS_BY_METHOD[method].some(
      (option) => option.value === requested,
    );
    if (supported) {
      return requested;
    }
  }
  return getThinkingValueFromConfig(config);
};

export const getResponsesFastModeFromConfig = (
  config: ApiConfigRecord,
): string => {
  const parsedConfig = parseConfigJson(config.configJson);
  const snowcfg = isRecord(parsedConfig.snowcfg) ? parsedConfig.snowcfg : {};
  const value = snowcfg.responsesFastMode;
  if (value === "fast" || value === "ultrafast") return value;
  return value === true ? "fast" : "off";
};

const buildConfigJsonWithThinking = (
  config: ApiConfigRecord,
  thinkingValue: string,
): string => {
  const parsedConfig = parseConfigJson(config.configJson);
  const snowcfg = {
    ...(isRecord(parsedConfig.snowcfg) ? parsedConfig.snowcfg : {}),
  };
  const requestMethod = normalizeRequestMethod(
    config.requestMethod || snowcfg.requestMethod,
  );
  const isThinkingEnabled = thinkingValue !== "none";

  snowcfg.requestMethod = config.requestMethod || requestMethod;

  if (requestMethod === "anthropic") {
    snowcfg.thinking = {
      type: "adaptive",
      enabled: isThinkingEnabled,
      effort: thinkingValue,
    };
  } else if (requestMethod === "gemini") {
    snowcfg.geminiThinking = {
      enabled: isThinkingEnabled,
      thinkingLevel: thinkingValue,
    };
  } else if (requestMethod === "responses") {
    snowcfg.responsesReasoning = {
      enabled: isThinkingEnabled,
      effort: thinkingValue,
    };
  } else {
    snowcfg.chatThinking = {
      enabled: isThinkingEnabled,
      reasoning_effort: thinkingValue,
    };
  }

  return JSON.stringify({
    ...parsedConfig,
    snowcfg,
  });
};

export const toConfigUpdatePayload = (
  config: ApiConfigRecord,
  thinkingValue: string,
): ApiConfigRecord => ({
  ...config,
  apiKey: "",
  visionApiKey: "",
  visionBaseUrlMode: config.visionBaseUrlMode || "auto",
  configJson: buildConfigJsonWithThinking(config, thinkingValue),
});

const buildConfigJsonWithModel = (
  config: ApiConfigRecord,
  modelId: string,
): string => {
  const parsedConfig = parseConfigJson(config.configJson);
  const snowcfg = {
    ...(isRecord(parsedConfig.snowcfg) ? parsedConfig.snowcfg : {}),
    advancedModel: modelId,
  };

  return JSON.stringify({
    ...parsedConfig,
    snowcfg,
  });
};

export const toModelUpdatePayload = (
  config: ApiConfigRecord,
  modelId: string,
): ApiConfigRecord => ({
  ...config,
  apiKey: "",
  visionApiKey: "",
  visionBaseUrlMode: config.visionBaseUrlMode || "auto",
  advancedModel: modelId,
  configJson: buildConfigJsonWithModel(config, modelId),
});
