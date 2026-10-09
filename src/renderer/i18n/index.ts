export {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  localeLabels,
  normalizeLocale,
  resources,
  type Locale,
} from "./locales";
export { I18nProvider, useI18n } from "./I18nProvider";
export { getActiveLocale, setActiveLocale } from "./activeLocale";
export {
  interpolate,
  tGlobal,
  translate,
  type TranslateOptions,
  type TranslationValues,
} from "./translate";
