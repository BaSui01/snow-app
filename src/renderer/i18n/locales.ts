import type { Locale } from "../../shared/locale";
import { en } from "./lang/en";
import { zhCN } from "./lang/zh-CN";
import { zhTW } from "./lang/zh-TW";

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

export const resources: Record<Locale, Record<string, string>> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};
