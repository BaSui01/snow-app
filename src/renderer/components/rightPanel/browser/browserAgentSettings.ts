import { useCallback, useEffect, useState } from "react";

export type BrowserAgentDomainMode = "off" | "allow" | "deny";

export type BrowserAgentSettings = {
  enabled: boolean;
  isolation: boolean;
  domainMode: BrowserAgentDomainMode;
  domains: string[];
};

export const BROWSER_AGENT_SETTING_NAME = "Browser agent access";
export const BROWSER_AGENT_SETTING_CODE = "browser_agent_settings";

/** Agent 自开标签页使用的内存级会话分区（不落盘、不共享用户登录态）。 */
export const BROWSER_AGENT_ISOLATED_PARTITION = "snow-agent-isolated";

export const DEFAULT_BROWSER_AGENT_SETTINGS: BrowserAgentSettings = {
  enabled: true,
  isolation: true,
  domainMode: "off",
  domains: [],
};

const DOMAIN_MODES: BrowserAgentDomainMode[] = ["off", "allow", "deny"];

const BROWSER_AGENT_SETTINGS_CHANGED_EVENT = "browser-agent-settings-changed";

export const normalizeBrowserAgentDomain = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  let raw = value.trim().toLowerCase();
  if (!raw) {
    return "";
  }
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  raw = raw.split("/")[0];
  raw = raw.split("?")[0];
  raw = raw.replace(/:\d+$/, "");
  if (raw.startsWith("*.")) {
    raw = raw.slice(2);
  }
  if (raw.startsWith(".")) {
    raw = raw.slice(1);
  }
  if (!raw || /[\s*]/.test(raw)) {
    return "";
  }
  return raw;
};

export const normalizeBrowserAgentSettings = (
  value: unknown,
): BrowserAgentSettings => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_BROWSER_AGENT_SETTINGS };
  }
  const record = value as Record<string, unknown>;
  const domainMode = DOMAIN_MODES.includes(
    record.domainMode as BrowserAgentDomainMode,
  )
    ? (record.domainMode as BrowserAgentDomainMode)
    : DEFAULT_BROWSER_AGENT_SETTINGS.domainMode;
  const domains = Array.isArray(record.domains)
    ? [
        ...new Set(
          record.domains
            .map((item) => normalizeBrowserAgentDomain(item))
            .filter((item) => item.length > 0),
        ),
      ]
    : [];
  return {
    enabled:
      typeof record.enabled === "boolean"
        ? record.enabled
        : DEFAULT_BROWSER_AGENT_SETTINGS.enabled,
    isolation:
      typeof record.isolation === "boolean"
        ? record.isolation
        : DEFAULT_BROWSER_AGENT_SETTINGS.isolation,
    domainMode,
    domains,
  };
};

export const readBrowserAgentSettingsJson = (
  value: string | null,
): BrowserAgentSettings => {
  if (!value) {
    return { ...DEFAULT_BROWSER_AGENT_SETTINGS };
  }
  try {
    return normalizeBrowserAgentSettings(JSON.parse(value));
  } catch {
    return { ...DEFAULT_BROWSER_AGENT_SETTINGS };
  }
};

export const resolveBrowserAgentHost = (url: string): string => {
  const raw = url.trim();
  if (!raw) {
    return "";
  }
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
};

const matchesBrowserAgentDomain = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

export const isBrowserAgentUrlAllowed = (
  url: string,
  settings: BrowserAgentSettings,
): boolean => {
  if (settings.domainMode === "off") {
    return true;
  }
  const host = resolveBrowserAgentHost(url);
  if (!host) {
    return true;
  }
  const matched = settings.domains.some((domain) =>
    matchesBrowserAgentDomain(host, domain),
  );
  return settings.domainMode === "allow" ? matched : !matched;
};

let cachedSettings: BrowserAgentSettings = {
  ...DEFAULT_BROWSER_AGENT_SETTINGS,
};
let settingsLoaded = false;
let loadStarted = false;
let globalListenerAttached = false;
const subscribers = new Set<() => void>();

const notifySubscribers = (): void => {
  for (const subscriber of subscribers) {
    subscriber();
  }
};

const loadBrowserAgentSettings = async (): Promise<void> => {
  try {
    const value = await window.snow.getSystemSettingValue(
      BROWSER_AGENT_SETTING_CODE,
    );
    cachedSettings = readBrowserAgentSettingsJson(value);
  } catch {
    cachedSettings = { ...DEFAULT_BROWSER_AGENT_SETTINGS };
  }
  settingsLoaded = true;
  notifySubscribers();
};

export const ensureBrowserAgentSettingsLoaded =
  async (): Promise<BrowserAgentSettings> => {
    if (!loadStarted) {
      loadStarted = true;
      globalListenerAttached = true;
      window.addEventListener(BROWSER_AGENT_SETTINGS_CHANGED_EVENT, () => {
        void loadBrowserAgentSettings();
      });
    }
    if (!settingsLoaded) {
      await loadBrowserAgentSettings();
    }
    return cachedSettings;
  };

ensureBrowserAgentSettingsLoaded().catch(() => {});

export const getBrowserAgentSettings = (): BrowserAgentSettings =>
  cachedSettings;

export const setBrowserAgentSettings = async (
  patch: Partial<BrowserAgentSettings>,
): Promise<BrowserAgentSettings> => {
  const next = normalizeBrowserAgentSettings({
    ...cachedSettings,
    ...patch,
  });
  await window.snow.setSystemSetting(
    BROWSER_AGENT_SETTING_NAME,
    BROWSER_AGENT_SETTING_CODE,
    JSON.stringify(next),
  );
  cachedSettings = next;
  settingsLoaded = true;
  loadStarted = true;
  notifySubscribers();
  window.dispatchEvent(new Event(BROWSER_AGENT_SETTINGS_CHANGED_EVENT));
  return next;
};

export const subscribeBrowserAgentSettings = (
  subscriber: () => void,
): (() => void) => {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
};

export function useBrowserAgentSettings(): {
  settings: BrowserAgentSettings;
  loaded: boolean;
  update: (patch: Partial<BrowserAgentSettings>) => Promise<void>;
} {
  const [, setVersion] = useState(0);

  useEffect(() => {
    void ensureBrowserAgentSettingsLoaded();
    return subscribeBrowserAgentSettings(() =>
      setVersion((version) => version + 1),
    );
  }, []);

  const update = useCallback(
    async (patch: Partial<BrowserAgentSettings>): Promise<void> => {
      await setBrowserAgentSettings(patch);
    },
    [],
  );

  return { settings: cachedSettings, loaded: settingsLoaded, update };
}
