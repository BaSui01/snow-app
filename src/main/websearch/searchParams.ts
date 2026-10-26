/**
 * 搜索参数映射：把统一的语言 / 时间范围 / site 参数翻译成各搜索引擎的 URL 参数。
 *
 * DuckDuckGo（lite 端点）与 Bing 的参数名不同，映射集中在表里，
 * 引擎实现只负责取用，无法识别的输入一律忽略（退化为引擎默认行为）。
 */

import type { SearchTimeRange } from "./types";

export type LanguageProfile = {
  /** DuckDuckGo 的 kl 参数（<region>-<lang>）。 */
  ddgKl: string;
  /** Bing 的 mkt 参数。 */
  bingMkt: string;
  /** Bing 的 setlang 参数。 */
  bingLang: string;
};

/** 支持的语言/区域，键为小写的 BCP-47 形式。 */
const LANGUAGE_PROFILES: Record<string, LanguageProfile> = {
  "zh-cn": { ddgKl: "cn-zh", bingMkt: "zh-CN", bingLang: "zh-Hans" },
  "zh-tw": { ddgKl: "tw-tzh", bingMkt: "zh-TW", bingLang: "zh-Hant" },
  "zh-hk": { ddgKl: "hk-tzh", bingMkt: "zh-HK", bingLang: "zh-Hant" },
  "en-us": { ddgKl: "us-en", bingMkt: "en-US", bingLang: "en" },
  "en-gb": { ddgKl: "uk-en", bingMkt: "en-GB", bingLang: "en" },
  "ja-jp": { ddgKl: "jp-jp", bingMkt: "ja-JP", bingLang: "ja" },
  "ko-kr": { ddgKl: "kr-kr", bingMkt: "ko-KR", bingLang: "ko" },
  "de-de": { ddgKl: "de-de", bingMkt: "de-DE", bingLang: "de" },
  "fr-fr": { ddgKl: "fr-fr", bingMkt: "fr-FR", bingLang: "fr" },
  "es-es": { ddgKl: "es-es", bingMkt: "es-ES", bingLang: "es" },
  "pt-br": { ddgKl: "br-pt", bingMkt: "pt-BR", bingLang: "pt" },
  "ru-ru": { ddgKl: "ru-ru", bingMkt: "ru-RU", bingLang: "ru" },
  "it-it": { ddgKl: "it-it", bingMkt: "it-IT", bingLang: "it" },
};

/** 只给语言码时的默认区域。 */
const LANGUAGE_DEFAULTS: Record<string, string> = {
  zh: "zh-cn",
  en: "en-us",
  ja: "ja-jp",
  ko: "ko-kr",
  de: "de-de",
  fr: "fr-fr",
  es: "es-es",
  pt: "pt-br",
  ru: "ru-ru",
  it: "it-it",
};

/** 规范化语言标识；无法识别时返回 undefined（引擎按自身默认处理）。 */
export const normalizeLanguage = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) {
    return undefined;
  }
  if (LANGUAGE_PROFILES[normalized]) {
    return normalized;
  }
  const fallback = LANGUAGE_DEFAULTS[normalized.split("-")[0]];
  return fallback && LANGUAGE_PROFILES[fallback] ? fallback : undefined;
};

export const resolveLanguageProfile = (
  language: string | undefined,
): LanguageProfile | null =>
  language ? (LANGUAGE_PROFILES[language] ?? null) : null;

export type TimeFilter = {
  /** DuckDuckGo 的 df 参数。 */
  ddgDf: string;
  /** Bing 的 filters 参数。 */
  bingFilters: string;
};

const TIME_FILTERS: Record<SearchTimeRange, TimeFilter> = {
  day: { ddgDf: "d", bingFilters: 'ex1:"ez1"' },
  week: { ddgDf: "w", bingFilters: 'ex1:"ez2"' },
  month: { ddgDf: "m", bingFilters: 'ex1:"ez3"' },
  year: { ddgDf: "y", bingFilters: 'ex1:"ez5"' },
};

/** 规范化时间范围；无法识别时返回 undefined（不做时间过滤）。 */
export const normalizeTimeRange = (
  value: unknown,
): SearchTimeRange | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized in TIME_FILTERS
    ? (normalized as SearchTimeRange)
    : undefined;
};

export const resolveTimeFilter = (
  timeRange: SearchTimeRange | undefined,
): TimeFilter | null => (timeRange ? TIME_FILTERS[timeRange] : null);

/** 域名校验：至少两段标签，标签只含字母/数字/连字符。 */
const HOST_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** 规范化 site 限定（接受裸域名或完整 URL）。 */
export const normalizeSite = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  let host = value.trim().toLowerCase();
  if (!host) {
    return undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return undefined;
    }
  }
  host = host
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/^\.+/, "");
  return host && HOST_PATTERN.test(host) ? host : undefined;
};

/** 把 site 限定拼进查询词（两个引擎都支持 site: 操作符）。 */
export const buildEngineQuery = (
  query: string,
  site: string | undefined,
): string => (site ? `${query} site:${site}` : query);
