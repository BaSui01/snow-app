/**
 * 工具卡片词条聚合：把各模块词条文件合并成三本词典，由 lang/{en,zh-CN,zh-TW}.ts
 * 展开（键前缀统一 remote.toolCall.<模块>.*，三语同键）。
 *
 * 模块文件两种导出形态都支持，便于上下游各自演进：
 *   - `<模块>En` / `<模块>ZhCN` / `<模块>ZhTW`（search / exec / filesystem / ops …）
 *   - `{ en, zhCN, zhTW }` 对象
 *
 * 合并顺序固定：common 放最后，公共键（如 collapse）可覆盖模块内的同义旧键。
 */
import * as agents from "./agents";
import * as common from "./common";
import * as diff from "./diff";
import * as exec from "./exec";
import * as filesystem from "./filesystem";
import * as ops from "./ops";
import * as search from "./search";
import * as web from "./web";

type ToolsLocale = "en" | "zhCN" | "zhTW";

/** 模块名 → 命名空间（模块名用于拼 <模块>En/<模块>ZhCN/<模块>ZhTW 旧命名）。 */
const MODULES: { name: string; ns: Record<string, unknown> }[] = [
  { name: "diff", ns: diff as unknown as Record<string, unknown> },
  { name: "exec", ns: exec as unknown as Record<string, unknown> },
  { name: "filesystem", ns: filesystem as unknown as Record<string, unknown> },
  { name: "ops", ns: ops as unknown as Record<string, unknown> },
  { name: "search", ns: search as unknown as Record<string, unknown> },
  { name: "web", ns: web as unknown as Record<string, unknown> },
  { name: "agents", ns: agents as unknown as Record<string, unknown> },
  { name: "common", ns: common as unknown as Record<string, unknown> },
];

const LOCALE_SUFFIX: Record<ToolsLocale, string> = {
  en: "En",
  zhCN: "ZhCN",
  zhTW: "ZhTW",
};

const isDict = (value: unknown): value is Record<string, string> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 取模块在指定语言下的词典（两种导出形态都接受，缺失返回空表）。 */
const dictOf = (
  ns: Record<string, unknown>,
  moduleName: string,
  locale: ToolsLocale,
): Record<string, string> => {
  const direct = ns[locale];
  if (isDict(direct)) return direct;
  const legacy = ns[`${moduleName}${LOCALE_SUFFIX[locale]}`];
  return isDict(legacy) ? legacy : {};
};

const merge = (locale: ToolsLocale): Record<string, string> => {
  const dict: Record<string, string> = {};
  for (const { name, ns } of MODULES) {
    Object.assign(dict, dictOf(ns, name, locale));
  }
  return dict;
};

export const toolsEn: Record<string, string> = merge("en");
export const toolsZhCN: Record<string, string> = merge("zhCN");
export const toolsZhTW: Record<string, string> = merge("zhTW");
