import type { TranslateOptions } from "../../../i18n";

type Translator = (key: string, options?: TranslateOptions) => string;

const REQUEST_METHOD_KEYS: Record<string, string> = {
  chat: "settings.usageRequestMethodChat",
  responses: "settings.usageRequestMethodResponses",
  anthropic: "settings.usageRequestMethodAnthropic",
  gemini: "settings.usageRequestMethodGemini",
  interactions: "settings.usageRequestMethodInteractions",
  oauth: "settings.usageRequestMethodOauth",
  decisions: "settings.usageRequestMethodDecisions",
};

/** 属于对话请求的协议：图表里这类记录不额外标注，避免噪音。 */
const CHAT_REQUEST_METHODS = new Set([
  "chat",
  "responses",
  "anthropic",
  "gemini",
  "interactions",
  "oauth",
]);

export const isChatRequestMethod = (method: string): boolean =>
  CHAT_REQUEST_METHODS.has(method.trim().toLowerCase());

/** 请求方式 → i18n 文案；未知值原样显示。 */
export const translateRequestMethod = (
  method: string,
  t: Translator,
): string => {
  const raw = method.trim();
  if (!raw) return "-";
  const key = REQUEST_METHOD_KEYS[raw.toLowerCase()];
  return key ? t(key, { defaultValue: raw }) : raw;
};
