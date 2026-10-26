import { existsSync } from "node:fs";
import type { NativeBridge } from "../native/types";
import { SNOW_CLI_PROXY_CONFIG_FILE } from "../snowCli/paths";
import { readJsonFile } from "../utils/jsonFile";
import { isRecord, toBoolean, toText } from "../utils/value";

export type ProxyBrowserSettings = {
  enabled: boolean;
  host: string;
  port: number;
  browserPath: string;
  browserDebugPort: number;
  searchEngines: string[];
  blockedPatterns: string[];
};

const PROXY_BROWSER_SETTING_NAME = "Proxy and browser settings";
const PROXY_BROWSER_SETTING_CODE = "proxy_browser_settings";
export const DEFAULT_PROXY_HOST = "127.0.0.1";
/** 默认搜索引擎：设置里一个都没配时使用。 */
const DEFAULT_SEARCH_ENGINES = ["duckduckgo"];
const DEFAULT_PROXY_BROWSER_SETTINGS: ProxyBrowserSettings = {
  enabled: false,
  host: DEFAULT_PROXY_HOST,
  port: 7890,
  browserPath: "",
  browserDebugPort: 9222,
  searchEngines: DEFAULT_SEARCH_ENGINES,
  blockedPatterns: [],
};

export const sanitizeProxyHost = (host: string | undefined): string => {
  if (!host) {
    return DEFAULT_PROXY_HOST;
  }
  const stripped = host.trim().replace(/^https?:\/\//i, "");
  return stripped || DEFAULT_PROXY_HOST;
};

const toPort = (value: unknown, defaultValue: number): number => {
  const port = typeof value === "number" ? value : Number(value);

  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? port
    : defaultValue;
};

/**
 * 解析搜索引擎列表：优先新字段，回退旧版单选字段
 * （`~/.snow/proxy-config.json` 同步过来的仍是 `searchEngine` 单值）。
 */
const toSearchEngines = (source: Record<string, unknown>): string[] => {
  const list = Array.isArray(source.searchEngines)
    ? source.searchEngines
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0)
    : [];

  if (list.length > 0) {
    return [...new Set(list)];
  }

  const legacy = toText(source.searchEngine).trim().toLowerCase();
  return legacy ? [legacy] : [...DEFAULT_SEARCH_ENGINES];
};

const normalizeProxyBrowserSettings = (
  value: unknown,
): ProxyBrowserSettings => {
  const source = isRecord(value) ? value : {};

  return {
    enabled: toBoolean(source.enabled, DEFAULT_PROXY_BROWSER_SETTINGS.enabled),
    host: sanitizeProxyHost(toText(source.host)),
    port: toPort(source.port, DEFAULT_PROXY_BROWSER_SETTINGS.port),
    browserPath: toText(source.browserPath).trim(),
    browserDebugPort: toPort(
      source.browserDebugPort,
      DEFAULT_PROXY_BROWSER_SETTINGS.browserDebugPort,
    ),
    searchEngines: toSearchEngines(source),
    blockedPatterns: Array.isArray(source.blockedPatterns)
      ? source.blockedPatterns
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [],
  };
};

const persistProxyBrowserSettings = async (
  native: NativeBridge,
  settings: ProxyBrowserSettings,
): Promise<ProxyBrowserSettings> => {
  await native.setSystemSetting(
    PROXY_BROWSER_SETTING_NAME,
    PROXY_BROWSER_SETTING_CODE,
    JSON.stringify(settings),
  );

  return settings;
};

export const readSnowCliProxyConfig = async (
  native: NativeBridge,
): Promise<ProxyBrowserSettings> => {
  if (!existsSync(SNOW_CLI_PROXY_CONFIG_FILE)) {
    return persistProxyBrowserSettings(native, DEFAULT_PROXY_BROWSER_SETTINGS);
  }

  const config = readJsonFile(SNOW_CLI_PROXY_CONFIG_FILE);
  return persistProxyBrowserSettings(
    native,
    normalizeProxyBrowserSettings(config),
  );
};
