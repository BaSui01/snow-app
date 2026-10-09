import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  type Locale,
} from "./locales";

/**
 * 非 React 上下文（模块级纯函数、事件回调、Worker 调用点）读取「当前 App 语言」。
 *
 * React 组件应通过 `useI18n().locale` 取语言（可在语言切换时自动重渲染）；
 * 但像 `formatMessageTime()` 这类模块级工具函数拿不到 Hook，只能读这里的快照。
 * 快照初值取自 localStorage 缓存，I18nProvider 在语言变化时通过
 * `setActiveLocale()` 同步，因此不依赖 Provider 的挂载顺序。
 */
const readCachedLocale = (): Locale => {
  if (typeof window === "undefined") {
    return DEFAULT_LOCALE;
  }

  try {
    return (
      normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY)) ??
      DEFAULT_LOCALE
    );
  } catch {
    // 存储不可用时退回默认语言。
    return DEFAULT_LOCALE;
  }
};

let activeLocale: Locale = readCachedLocale();

/** 读取当前 App 语言（用于 Intl 日期/数字格式化等非组件场景）。 */
export const getActiveLocale = (): Locale => activeLocale;

/** 由 I18nProvider 在语言初始化与切换时写入。 */
export const setActiveLocale = (locale: Locale): void => {
  activeLocale = locale;
};
