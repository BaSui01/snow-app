import type { PluginLocalizedMap } from "./types";

/** 市场条目的结构化字段（与 snow-plugin-store 的 registry.json 对应）。 */
export type MarketPluginEntry = {
  id: string;
  kind: "plugin" | "script";
  name: PluginLocalizedMap;
  description: PluginLocalizedMap;
  author: string;
  homepage: string;
  repo: string;
  version: string;
  tag: string;
  asset: string;
  downloadUrl: string;
  sha256: string;
  minAppVersion: string;
  privacy: string[];
  tags: string[];
  icon: string;
};

export type MarketRegistry = {
  schemaVersion: number;
  updatedAt: string;
  plugins: MarketPluginEntry[];
};

export const PLUGIN_MARKET_REPO_URL =
  "https://github.com/MayDay-wpf/snow-plugin-store";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const toLocalized = (value: unknown): PluginLocalizedMap => {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? { default: text } : {};
  }
  if (!isRecord(value)) {
    return {};
  }
  const result: PluginLocalizedMap = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      continue;
    }
    const text = item.trim();
    if (text) {
      result[key] = text;
    }
  }
  return result;
};

const toStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
};

const MARKET_SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const GITHUB_REPO_PATTERN = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/i;

const normalizeRepoUrl = (value: string): string =>
  value
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

/** 解析市场索引文本；单个无效条目会被丢弃，不会让整份索引失败。 */
export const parseMarketRegistry = (text: string): MarketRegistry => {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("Invalid plugin market registry");
  }
  const rawPlugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
  const plugins: MarketPluginEntry[] = [];
  for (const raw of rawPlugins) {
    if (!isRecord(raw)) {
      continue;
    }
    const id = asTrimmedString(raw.id);
    const repo = normalizeRepoUrl(asTrimmedString(raw.repo));
    const version = asTrimmedString(raw.version);
    const sha256 = asTrimmedString(raw.sha256);
    if (
      !id ||
      !GITHUB_REPO_PATTERN.test(repo) ||
      !version ||
      !MARKET_SHA256_PATTERN.test(sha256)
    ) {
      continue;
    }
    plugins.push({
      id,
      kind: raw.kind === "script" ? "script" : "plugin",
      name: toLocalized(raw.name),
      description: toLocalized(raw.description),
      author: asTrimmedString(raw.author),
      homepage: asTrimmedString(raw.homepage),
      repo,
      version,
      tag: asTrimmedString(raw.tag),
      asset: asTrimmedString(raw.asset),
      downloadUrl: asTrimmedString(raw.downloadUrl),
      sha256: sha256.toLowerCase(),
      minAppVersion: asTrimmedString(raw.minAppVersion),
      privacy: toStringList(raw.privacy),
      tags: toStringList(raw.tags),
      icon: asTrimmedString(raw.icon),
    });
  }
  return {
    schemaVersion:
      typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
    updatedAt: asTrimmedString(parsed.updatedAt),
    plugins,
  };
};

/** 构造条目的 zip 下载直链；缺少可用分发信息时返回 null。 */
export const buildMarketDownloadUrl = (
  entry: MarketPluginEntry,
): string | null => {
  if (entry.downloadUrl.startsWith("https://")) {
    return entry.downloadUrl;
  }
  const match = GITHUB_REPO_PATTERN.exec(entry.repo);
  if (!match || !entry.tag || !entry.asset) {
    return null;
  }
  return `https://github.com/${match[1]}/${match[2]}/releases/download/${entry.tag}/${entry.asset}`;
};

/** 简单版本比较（-1 / 0 / 1）：容忍 v 前缀，非数字段按 0 处理。 */
export const compareMarketVersions = (left: string, right: string): number => {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) && part > 0 ? part : 0));
  const leftParts = parse(left);
  const rightParts = parse(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
};

/** 市场版本是否高于本地已安装版本。 */
export const hasMarketUpdate = (
  installedVersion: string,
  marketVersion: string,
): boolean => compareMarketVersions(installedVersion, marketVersion) < 0;

/** 市场条目要求的应用版本是否高于当前应用版本。 */
export const isMarketEntryTooNew = (
  entry: MarketPluginEntry,
  appVersion: string,
): boolean =>
  Boolean(entry.minAppVersion) &&
  Boolean(appVersion) &&
  compareMarketVersions(appVersion, entry.minAppVersion) < 0;
