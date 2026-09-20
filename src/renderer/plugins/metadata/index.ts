import type { Locale } from "../../../shared/locale";
import { runtimeSnapshot } from "../runtimeSnapshot";
import type { MetadataResponse, PluginView, SensitiveScope } from "../types";
import {
  METADATA_DOMAINS,
  type MetadataContext,
  type MetadataDomainDefinition,
} from "./domains";

/** 任意域中出现即视为密钥的字段名（按名称匹配，小写比较）。 */
const GLOBAL_SENSITIVE_FIELDS: Record<string, SensitiveScope> = {
  apikey: "apiKeys",
  visionapikey: "apiKeys",
  secret: "apiKeys",
  secretkey: "apiKeys",
  password: "apiKeys",
  passphrase: "apiKeys",
  token: "apiKeys",
  accesstoken: "apiKeys",
  refreshtoken: "apiKeys",
  privatekey: "apiKeys",
  credentials: "apiKeys",
};

export type MetadataDomainSummary = {
  id: string;
  scope: SensitiveScope | null;
  granted: boolean;
  live: boolean;
  sensitiveFields: Record<string, SensitiveScope>;
};

const domainIndex = new Map<string, MetadataDomainDefinition>(
  METADATA_DOMAINS.map((domain) => [domain.id, domain])
);

const mergeSensitiveFields = (
  definition: MetadataDomainDefinition
): Record<string, SensitiveScope> => {
  const merged: Record<string, SensitiveScope> = { ...GLOBAL_SENSITIVE_FIELDS };
  for (const [field, scope] of Object.entries(
    definition.sensitiveFields ?? {}
  )) {
    merged[field.toLowerCase()] = scope;
  }
  return merged;
};

const redactValue = (
  value: unknown,
  fields: Record<string, SensitiveScope>,
  granted: Set<string>,
  path: string,
  withheld: string[]
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactValue(item, fields, granted, `${path}[${index}]`, withheld)
    );
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    const scope = fields[key.toLowerCase()];
    if (scope && !granted.has(scope)) {
      withheld.push(childPath);
      continue;
    }
    result[key] = redactValue(item, fields, granted, childPath, withheld);
  }
  return result;
};

export const buildMetadataContext = (
  plugin: PluginView,
  locale: Locale,
  params: Record<string, unknown>
): MetadataContext => ({
  locale,
  plugin,
  params,
  snapshot: runtimeSnapshot.get(),
});

/** 插件可访问的元数据域清单（含隐私声明是否满足）。 */
export const describeMetadataDomains = (
  plugin: PluginView
): MetadataDomainSummary[] => {
  const granted = new Set(plugin.privacy);
  return METADATA_DOMAINS.map((definition) => ({
    id: definition.id,
    scope: definition.scope ?? null,
    granted: !definition.scope || granted.has(definition.scope),
    live: Boolean(definition.live),
    sensitiveFields: mergeSensitiveFields(definition),
  }));
};

export type MetadataCollectOptions = {
  params?: Record<string, unknown>;
};

/** 采集指定元数据域；未声明隐私域的敏感域返回失败原因。 */
export const collectMetadata = async (
  plugin: PluginView,
  locale: Locale,
  domainIds: string[],
  options: MetadataCollectOptions = {}
): Promise<MetadataResponse> => {
  const granted = new Set(plugin.privacy);
  const response: MetadataResponse = {
    generatedAt: Date.now(),
    domains: {},
    denied: {},
    withheld: {},
    unknown: [],
  };

  const requested = domainIds.length
    ? Array.from(new Set(domainIds.map((id) => id.trim()).filter(Boolean)))
    : METADATA_DOMAINS.map((domain) => domain.id);

  for (const domainId of requested) {
    const definition = domainIndex.get(domainId);
    if (!definition) {
      response.unknown.push(domainId);
      continue;
    }
    if (definition.scope && !granted.has(definition.scope)) {
      response.denied[domainId] = {
        reason: "privacy-declaration-missing",
        scope: definition.scope,
      };
      continue;
    }

    const context = buildMetadataContext(plugin, locale, options.params ?? {});
    let data: unknown;
    try {
      data = await definition.collect(context);
    } catch (error) {
      response.denied[domainId] = {
        reason: "privacy-declaration-missing",
        scope: definition.scope ?? "privacyConfig",
      };
      console.error(`Plugin metadata domain '${domainId}' failed`, error);
      continue;
    }

    const withheld: string[] = [];
    const redacted = redactValue(
      data,
      mergeSensitiveFields(definition),
      granted,
      "",
      withheld
    );
    response.domains[domainId] = redacted;
    if (withheld.length > 0) {
      response.withheld[domainId] = withheld;
    }
  }

  return response;
};

export type MetadataSubscription = { unsubscribe: () => void };

/**
 * 订阅元数据域：live 域随实时快照变化重新采集，其余域按 intervalMs 轮询
 * （未指定间隔时只推送一次初始值）。
 */
export const subscribeMetadata = async (
  plugin: PluginView,
  locale: Locale,
  domainId: string,
  listener: (response: MetadataResponse) => void,
  options: MetadataCollectOptions & { intervalMs?: number } = {}
): Promise<MetadataSubscription> => {
  const definition = domainIndex.get(domainId);
  if (!definition) {
    listener({
      generatedAt: Date.now(),
      domains: {},
      denied: {},
      withheld: {},
      unknown: [domainId],
    });
    return { unsubscribe: () => undefined };
  }

  let disposed = false;
  let timer: number | null = null;
  let debounce: number | null = null;

  const emit = async (): Promise<void> => {
    const response = await collectMetadata(plugin, locale, [domainId], {
      params: options.params,
    });
    if (!disposed) {
      listener(response);
    }
  };

  void emit();

  const intervalMs = Number(options.intervalMs ?? 0);
  const unsubscribers: (() => void)[] = [];

  if (definition.live) {
    unsubscribers.push(
      runtimeSnapshot.subscribe(() => {
        if (disposed) {
          return;
        }
        if (debounce !== null) {
          window.clearTimeout(debounce);
        }
        debounce = window.setTimeout(() => {
          debounce = null;
          void emit();
        }, 200);
      })
    );
  }

  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    timer = window.setInterval(() => {
      void emit();
    }, Math.max(1000, intervalMs));
  }

  return {
    unsubscribe: () => {
      disposed = true;
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      if (timer !== null) {
        window.clearInterval(timer);
      }
      if (debounce !== null) {
        window.clearTimeout(debounce);
      }
    },
  };
};

export { METADATA_DOMAINS };
export type { MetadataContext, MetadataDomainDefinition };
