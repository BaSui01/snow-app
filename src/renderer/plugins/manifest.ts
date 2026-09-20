import type { Locale } from "../../shared/locale";
import type { PluginRecord } from "../../preload/types/plugins";
import type {
  PluginLocalizedMap,
  PluginPanelDefinition,
  PluginRenderMode,
  PluginView,
} from "./types";
import { isSensitiveScope } from "./types";

const parseJson = <T>(raw: string, fallback: T): T => {
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

const normalizeLocalizedMap = (value: unknown): PluginLocalizedMap => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? { default: trimmed } : {};
  }
  if (!value || typeof value !== "object") {
    return {};
  }
  const result: PluginLocalizedMap = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed) {
      result[key] = trimmed;
    }
  }
  return result;
};

const PRIMARY_LOCALE_TAG: Record<Locale, string> = {
  en: "en",
  "zh-CN": "zh",
  "zh-TW": "zh",
};

export const resolveLocalized = (
  map: PluginLocalizedMap,
  locale: Locale
): string => {
  if (map[locale]) {
    return map[locale];
  }
  const lower = locale.toLowerCase();
  for (const [key, value] of Object.entries(map)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  const primary = PRIMARY_LOCALE_TAG[locale];
  for (const [key, value] of Object.entries(map)) {
    const normalized = key.toLowerCase();
    if (normalized === primary || normalized.split("-")[0] === primary) {
      return value;
    }
  }
  return map.default ?? Object.values(map)[0] ?? "";
};

/** 依据应用语言挑选插件的语言包文件路径。 */
export const pickLocaleFile = (
  locales: Record<string, string>,
  locale: Locale
): string | null => {
  if (locales[locale]) {
    return locales[locale];
  }
  const lower = locale.toLowerCase();
  for (const [key, value] of Object.entries(locales)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  const primary = PRIMARY_LOCALE_TAG[locale];
  for (const [key, value] of Object.entries(locales)) {
    if (key.toLowerCase().split("-")[0] === primary) {
      return value;
    }
  }
  return locales.default ?? Object.values(locales)[0] ?? null;
};

const normalizePanels = (value: unknown): PluginPanelDefinition[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const panels: PluginPanelDefinition[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      continue;
    }
    panels.push({
      id,
      title: normalizeLocalizedMap(record.title),
      entry: typeof record.entry === "string" ? record.entry.trim() : "",
      icon: typeof record.icon === "string" ? record.icon.trim() : "",
      widthHint:
        typeof record.widthHint === "string" ? record.widthHint.trim() : "",
    });
  }
  return panels;
};

export const parsePluginRecord = (record: PluginRecord): PluginView => ({
  pluginId: record.pluginId,
  name: normalizeLocalizedMap(parseJson(record.name, {})),
  description: normalizeLocalizedMap(parseJson(record.description, {})),
  version: record.version,
  author: record.author,
  homepage: record.homepage,
  license: record.license,
  icon: record.icon,
  renderMode: (record.renderMode === "iframe" ? "iframe" : "esm") as PluginRenderMode,
  entry: record.entry,
  panels: normalizePanels(parseJson(record.panels, [])),
  locales: parseJson(record.locales, {}),
  styles: parseJson<string[]>(record.styles, []).filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0
  ),
  privacy: Array.isArray(record.privacy)
    ? record.privacy.filter(isSensitiveScope)
    : [],
  privacyNote: record.privacyNote,
  minAppVersion: record.minAppVersion,
  enabled: record.enabled,
  installPath: record.installPath,
  sourcePath: record.sourcePath,
  sortOrder: record.sortOrder,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

/** 插件图标：lucide:IconName / 相对路径 / 内联或远程 URL。 */
export const resolvePluginIcon = (
  icon: string
): { kind: "lucide"; name: string } | { kind: "asset"; path: string } | null => {
  const trimmed = icon.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.toLowerCase().startsWith("lucide:")) {
    return { kind: "lucide", name: trimmed.slice("lucide:".length).trim() };
  }
  if (/^(https?:|data:)/i.test(trimmed)) {
    return null;
  }
  return { kind: "asset", path: trimmed };
};

const localeTagCandidates = (locale: Locale): string[] => {
  if (locale === "zh-CN") {
    return ["zh-CN", "zh", "en"];
  }
  if (locale === "zh-TW") {
    return ["zh-TW", "zh", "en"];
  }
  return ["en", "zh-CN", "zh"];
};

/** 读取插件语言包（缺失时返回空表，调用方回退到插件自带文案）。 */
export const loadPluginMessages = async (
  plugin: PluginView,
  locale: Locale
): Promise<Record<string, string>> => {
  const direct = pickLocaleFile(plugin.locales, locale);
  if (direct) {
    try {
      const raw = await window.snow.readPluginFile(plugin.pluginId, direct);
      return parseJson<Record<string, string>>(raw, {});
    } catch {
      return {};
    }
  }

  for (const tag of localeTagCandidates(locale)) {
    const candidate = plugin.locales[tag];
    if (!candidate) {
      continue;
    }
    try {
      const raw = await window.snow.readPluginFile(plugin.pluginId, candidate);
      return parseJson<Record<string, string>>(raw, {});
    } catch {
      continue;
    }
  }
  return {};
};
