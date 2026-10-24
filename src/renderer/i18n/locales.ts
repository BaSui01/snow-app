import type { Locale } from "../../shared/locale";
import { en } from "./lang/en";
import { zhCN } from "./lang/zh-CN";
import { zhTW } from "./lang/zh-TW";
import { imageGenerationTranslations } from "./lang/imageGeneration";
import { browserToolTranslations } from "./lang/browserTools";
import { browserToolErrorTranslations } from "./lang/browserToolErrors";
import { subAgentExecutionModeTranslations } from "./lang/subAgentExecutionMode";
import { subAgentToolTranslations } from "./lang/subAgentTools";
import { markdownAcceptanceTranslations } from "./lang/markdownAcceptance";
import { toolResultTranslations } from "./lang/toolResults";
import { responseFailureTranslations } from "./lang/responseFailures";

// 语言集合与归一化规则与主进程、Mobile 远控页共用同一份实现
// （src/shared/locale.ts），这里仅保留 Renderer 专有的词典与展示名。
export {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
  type Locale,
} from "../../shared/locale";

export const localeLabels: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
};

// Browser result and error dictionaries share the same locale fallback chain.
export const resources: Record<Locale, Record<string, string>> = {
  en: {
    ...markdownAcceptanceTranslations.en,
    ...toolResultTranslations.en,
    ...en,
    ...imageGenerationTranslations.en,
    ...browserToolTranslations.en,
    ...browserToolErrorTranslations.en,
    ...subAgentExecutionModeTranslations.en,
    ...subAgentToolTranslations.en,
    ...responseFailureTranslations.en,
  },
  "zh-CN": {
    ...markdownAcceptanceTranslations["zh-CN"],
    ...toolResultTranslations["zh-CN"],
    ...zhCN,
    ...imageGenerationTranslations["zh-CN"],
    ...browserToolTranslations["zh-CN"],
    ...browserToolErrorTranslations["zh-CN"],
    ...subAgentExecutionModeTranslations["zh-CN"],
    ...subAgentToolTranslations["zh-CN"],
    ...responseFailureTranslations["zh-CN"],
  },
  "zh-TW": {
    ...markdownAcceptanceTranslations["zh-TW"],
    ...toolResultTranslations["zh-TW"],
    ...zhTW,
    ...imageGenerationTranslations["zh-TW"],
    ...browserToolTranslations["zh-TW"],
    ...browserToolErrorTranslations["zh-TW"],
    ...subAgentExecutionModeTranslations["zh-TW"],
    ...subAgentToolTranslations["zh-TW"],
    ...responseFailureTranslations["zh-TW"],
  },
};
