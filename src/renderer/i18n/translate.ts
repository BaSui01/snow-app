import { getActiveLocale } from "./activeLocale";
import { DEFAULT_LOCALE, resources, type Locale } from "./locales";

export type TranslationValues = Record<string, string | number>;

export type TranslateOptions = {
  defaultValue?: string;
  values?: TranslationValues;
};

/** 把 `{{name}}` 占位符替换为 values 中的值（缺失的占位符原样保留）。 */
export const interpolate = (
  template: string,
  values?: TranslationValues,
): string => {
  if (!values) {
    return template;
  }

  return template.replace(/{{\s*(\w+)\s*}}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
};

/**
 * 按指定语言查词条：缺失回退 DEFAULT_LOCALE（en），再回退 defaultValue，最后回退 key。
 *
 * React 组件请用 `useI18n().t`（语言变化会自动重渲染）；这里是给
 * I18nProvider 与非组件上下文共用的底层实现。
 */
export const translate = (
  locale: Locale,
  key: string,
  options?: TranslateOptions,
): string => {
  const template =
    resources[locale][key] ??
    resources[DEFAULT_LOCALE][key] ??
    options?.defaultValue ??
    key;

  return interpolate(template, options?.values);
};

/**
 * 非组件上下文（模块级纯函数、Worker、注入页面的脚本、事件回调）按「当前
 * App 语言」查词条。调用时机是运行期，因此读到的是最新语言；但不会像
 * React 组件那样在语言切换时自动重渲染，需要重渲染的场景仍应走 useI18n。
 */
export const tGlobal = (key: string, options?: TranslateOptions): string =>
  translate(getActiveLocale(), key, options);
