import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  type Locale,
} from "../../shared/locale";
import { en } from "./lang/en";
import { zhCN } from "./lang/zh-CN";
import { zhTW } from "./lang/zh-TW";

/**
 * Mobile 远控页的语言选择：
 *   1. 手机浏览器 localStorage 的显式覆盖（键与桌面 Renderer 相同）；
 *   2. 主进程在服务页面时注入的桌面语言（<meta name="snow-locale">）；
 *   3. 手机浏览器语言（navigator.language）；
 *   4. 默认语言（en）。
 *
 * 词典插值约定与桌面 Renderer 一致：{{name}} 形式。
 */
const dictionaries: Record<Locale, Record<string, string>> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

let activeLocale: Locale = DEFAULT_LOCALE;

const interpolate = (
  template: string,
  values?: Record<string, string | number>,
): string => {
  if (!values) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
};

export const t = (
  key: string,
  values?: Record<string, string | number>,
): string => {
  const template =
    dictionaries[activeLocale][key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key;
  return interpolate(template, values);
};

/** 供日期格式化等 Intl API 使用；当前语言的 BCP 47 标记。 */
export const localeBcp47 = (): string => activeLocale;

const readInjectedLocale = (): Locale | null => {
  const meta = document.querySelector('meta[name="snow-locale"]');
  return normalizeLocale(meta?.getAttribute("content"));
};

const readStoredLocale = (): Locale | null => {
  try {
    return normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
};

/** 翻译静态骨架：文本、placeholder、aria-label 与 alt 四类可翻译属性。 */
const translateDom = (root: ParentNode): void => {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n ?? "");
  });
  root
    .querySelectorAll<HTMLElement>("[data-i18n-placeholder]")
    .forEach((el) => {
      el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder ?? ""));
    });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel ?? ""));
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-alt]").forEach((el) => {
    el.setAttribute("alt", t(el.dataset.i18nAlt ?? ""));
  });
};

/**
 * 初始化语言：确定 activeLocale、更新 <html lang>、翻译静态骨架，
 * 最后移除 data-i18n-pending（样式表在翻译完成前隐藏 body，避免语言闪烁）。
 */
export const initI18n = (): void => {
  activeLocale =
    readStoredLocale() ??
    readInjectedLocale() ??
    normalizeLocale(navigator.language) ??
    DEFAULT_LOCALE;
  document.documentElement.lang = activeLocale;
  translateDom(document);
  document.documentElement.removeAttribute("data-i18n-pending");
};
