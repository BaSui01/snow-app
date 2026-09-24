import * as ReactNamespace from "react";

import type { Locale } from "../../shared/locale";
import {
  collectMetadata,
  describeMetadataDomains,
  subscribeMetadata,
  type MetadataCollectOptions,
  type MetadataDomainSummary,
  type MetadataSubscription,
} from "./metadata";
import type { MetadataResponse, PluginView } from "./types";
import { describeWriteDomains, executeWrite, WRITE_ACTION_IDS } from "./writes";
import type {
  PluginWriteDomainSummary,
  PluginWriteResponse,
} from "./writes/types";

type TranslationValues = Record<string, string | number>;

type TranslateOptions = {
  defaultValue?: string;
  values?: TranslationValues;
};

export type PluginMetadataApi = {
  get: (
    domain: string | string[],
    options?: MetadataCollectOptions,
  ) => Promise<MetadataResponse>;
  subscribe: (
    domain: string,
    listener: (response: MetadataResponse) => void,
    options?: MetadataCollectOptions & { intervalMs?: number },
  ) => Promise<MetadataSubscription>;
  domains: () => MetadataDomainSummary[];
};

export type PluginStorageApi = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
  all: () => Promise<Record<string, string>>;
  getJson: <T>(key: string, fallback: T) => Promise<T>;
  setJson: (key: string, value: unknown) => Promise<void>;
};

export type PluginWriteApi = {
  run: (
    actionId: string,
    params?: Record<string, unknown>,
  ) => Promise<PluginWriteResponse>;
  domains: () => PluginWriteDomainSummary[];
} & Record<string, unknown>;

export type PluginRuntimeApi = {
  id: string;
  version: string;
  name: string;
  installPath: string;
  locale: Locale;
  t: (key: string, options?: TranslateOptions) => string;
  metadata: PluginMetadataApi;
  write: PluginWriteApi;
  storage: PluginStorageApi;
  assets: { resolve: (relativePath: string) => Promise<string | null> };
  ui: {
    React: typeof ReactNamespace;
    icon: (name: string) => unknown;
  };
  log: (...args: unknown[]) => void;
};

const interpolate = (template: string, values?: TranslationValues): string => {
  if (!values) {
    return template;
  }
  return template.replace(/{{\s*(\w+)\s*}}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
};

const createWriteApi = (plugin: PluginView, locale: Locale): PluginWriteApi => {
  const run = (
    actionId: string,
    params?: Record<string, unknown>,
  ): Promise<PluginWriteResponse> =>
    executeWrite({ plugin, locale, actionId, params: params ?? {} });
  const api: Record<string, unknown> = {
    run,
    domains: () => describeWriteDomains(plugin, locale),
  };
  for (const actionId of WRITE_ACTION_IDS) {
    const separator = actionId.indexOf(".");
    const domain = actionId.slice(0, separator);
    const action = actionId.slice(separator + 1);
    if (!domain || !action) {
      continue;
    }
    const domainApi = (api[domain] ?? {}) as Record<string, unknown>;
    domainApi[action] = (params?: Record<string, unknown>) =>
      run(actionId, params);
    api[domain] = domainApi;
  }
  return api as PluginWriteApi;
};

export const createPluginApi = async (params: {
  plugin: PluginView;
  locale: Locale;
  messages: Record<string, string>;
  icons: Record<string, unknown>;
}): Promise<PluginRuntimeApi> => {
  const { plugin, locale, messages, icons } = params;
  const storageCache = new Map<string, string>();

  const storage: PluginStorageApi = {
    get: async (key) => storageCache.get(key) ?? null,
    set: async (key, value) => {
      storageCache.set(key, value);
      await window.snow.setPluginValue(plugin.pluginId, key, value);
    },
    remove: async (key) => {
      storageCache.delete(key);
      await window.snow.deletePluginValue(plugin.pluginId, key);
    },
    all: async () => Object.fromEntries(storageCache),
    getJson: async <T>(key: string, fallback: T): Promise<T> => {
      const raw = storageCache.get(key);
      if (!raw) {
        return fallback;
      }
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    },
    setJson: async (key, value) => {
      await storage.set(key, JSON.stringify(value ?? null));
    },
  };

  try {
    const values = await window.snow.getPluginValues(plugin.pluginId);
    for (const entry of values) {
      storageCache.set(entry.key, entry.value);
    }
  } catch (error) {
    console.warn(`Failed to load plugin storage for ${plugin.pluginId}`, error);
  }

  return {
    id: plugin.pluginId,
    version: plugin.version,
    name: plugin.name[locale] ?? plugin.name.default ?? plugin.pluginId,
    installPath: plugin.installPath,
    locale,
    t: (key, options) => {
      const template =
        messages[key] ?? options?.defaultValue ?? plugin.name[key] ?? key;
      return interpolate(template, options?.values);
    },
    metadata: {
      get: (domain, options) =>
        collectMetadata(
          plugin,
          locale,
          Array.isArray(domain) ? domain : [domain],
          options ?? {},
        ),
      subscribe: (domain, listener, options) =>
        subscribeMetadata(plugin, locale, domain, listener, options ?? {}),
      domains: () => describeMetadataDomains(plugin),
    },
    write: createWriteApi(plugin, locale),
    storage,
    assets: {
      resolve: (relativePath) =>
        window.snow.readPluginAsset(plugin.pluginId, relativePath),
    },
    ui: {
      React: ReactNamespace,
      icon: (name) => icons[name] ?? null,
    },
    log: (...args) => {
      console.log(`[plugin:${plugin.pluginId}]`, ...args);
    },
  };
};
