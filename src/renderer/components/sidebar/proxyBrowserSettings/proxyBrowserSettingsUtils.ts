import type { ProxyBrowserSettings } from "../../../../preload";
import {
  DEFAULT_PROXY_BROWSER_SETTINGS,
  DEFAULT_PROXY_HOST,
} from "./proxyBrowserSettingsConstants";
import type { ProxyBrowserSettingsForm } from "./types";

export const sanitizeProxyHost = (host: string | undefined): string => {
  if (!host) {
    return DEFAULT_PROXY_HOST;
  }
  const stripped = host.trim().replace(/^https?:\/\//i, "");
  return stripped || DEFAULT_PROXY_HOST;
};

export const parsePort = (value: string, fallback: number): number => {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toText = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const toBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const toTextArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];

export const normalizeProxyBrowserSettings = (
  value: unknown
): ProxyBrowserSettings => {
  const source = isRecord(value) ? value : {};

  return {
    enabled: toBoolean(source.enabled, DEFAULT_PROXY_BROWSER_SETTINGS.enabled),
    host: sanitizeProxyHost(toText(source.host)),
    port: parsePort(
      String(source.port ?? ""),
      DEFAULT_PROXY_BROWSER_SETTINGS.port
    ),
    browserPath: toText(source.browserPath).trim(),
    browserDebugPort: parsePort(
      String(source.browserDebugPort ?? ""),
      DEFAULT_PROXY_BROWSER_SETTINGS.browserDebugPort
    ),
    searchEngine:
      toText(
        source.searchEngine,
        DEFAULT_PROXY_BROWSER_SETTINGS.searchEngine
      ).trim() || DEFAULT_PROXY_BROWSER_SETTINGS.searchEngine,
    blockedPatterns: toTextArray(source.blockedPatterns),
  };
};

export const readProxyBrowserSettingsJson = (
  value: string | null
): ProxyBrowserSettings => {
  if (!value) {
    return DEFAULT_PROXY_BROWSER_SETTINGS;
  }

  try {
    return normalizeProxyBrowserSettings(JSON.parse(value) as unknown);
  } catch {
    return DEFAULT_PROXY_BROWSER_SETTINGS;
  }
};

export const toProxyBrowserForm = (
  settings: ProxyBrowserSettings
): ProxyBrowserSettingsForm => ({
  enabled: settings.enabled,
  host: settings.host,
  port: String(settings.port),
  browserPath: settings.browserPath,
  browserDebugPort: String(settings.browserDebugPort),
  searchEngine: settings.searchEngine,
  blockedPatternsText: settings.blockedPatterns.join("\n"),
});

export const toProxyBrowserSettings = (
  form: ProxyBrowserSettingsForm
): ProxyBrowserSettings => ({
  enabled: form.enabled,
  host: sanitizeProxyHost(form.host),
  port: parsePort(form.port, DEFAULT_PROXY_BROWSER_SETTINGS.port),
  browserPath: form.browserPath.trim(),
  browserDebugPort: parsePort(
    form.browserDebugPort,
    DEFAULT_PROXY_BROWSER_SETTINGS.browserDebugPort
  ),
  searchEngine:
    form.searchEngine.trim() || DEFAULT_PROXY_BROWSER_SETTINGS.searchEngine,
  blockedPatterns: form.blockedPatternsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0),
});
