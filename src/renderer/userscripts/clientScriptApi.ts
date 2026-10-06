import type { ClientScriptApiHostHandler } from "../../preload/types/userscripts";
import type { Locale } from "../../shared/locale";
import {
  collectMetadata,
  describeMetadataDomains,
  subscribeMetadata,
  type MetadataSubscription,
} from "../plugins/metadata";
import type { PluginView, SensitiveScope } from "../plugins/types";
import { isSensitiveScope } from "../plugins/types";
import { describeWriteDomains, executeWrite } from "../plugins/writes";

type ScriptInfo = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  privacy?: unknown;
};

const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

const buildScriptPluginView = (
  scriptId: string,
  info: ScriptInfo,
): PluginView => ({
  pluginId: scriptId,
  name: {
    default: typeof info.name === "string" && info.name ? info.name : scriptId,
  },
  description: {
    default: typeof info.description === "string" ? info.description : "",
  },
  version:
    typeof info.version === "string" && info.version ? info.version : "1.0",
  author: "",
  homepage: "",
  license: "",
  icon: "",
  renderMode: "esm",
  entry: "",
  panels: [],
  messageFooters: [],
  locales: {},
  styles: [],
  privacy: Array.isArray(info.privacy)
    ? info.privacy.filter(
        (scope): scope is SensitiveScope =>
          typeof scope === "string" && isSensitiveScope(scope),
      )
    : [],
  privacyNote: "",
  minAppVersion: "",
  enabled: true,
  installPath: "",
  sourcePath: "",
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
});

export const installClientScriptApi = (locale: Locale): (() => void) => {
  const subscriptions = new Map<string, Map<string, MetadataSubscription>>();

  const releaseScript = (scriptId: string): void => {
    const perScript = subscriptions.get(scriptId);
    if (!perScript) {
      return;
    }
    for (const subscription of perScript.values()) {
      subscription.unsubscribe();
    }
    subscriptions.delete(scriptId);
  };

  const handler: ClientScriptApiHostHandler = async (
    scriptId,
    infoJson,
    method,
    argsJson,
  ): Promise<string> => {
    const info = parseJson<ScriptInfo>(infoJson, {});
    const plugin = buildScriptPluginView(scriptId, info);
    const args = parseJson<unknown[]>(argsJson, []);
    const first =
      args[0] && typeof args[0] === "object"
        ? (args[0] as Record<string, unknown>)
        : {};

    switch (method) {
      case "metadata-get": {
        const domains = Array.isArray(first.domains)
          ? first.domains.filter(
              (item): item is string => typeof item === "string",
            )
          : [];
        const params =
          first.params && typeof first.params === "object"
            ? (first.params as Record<string, unknown>)
            : {};
        const response = await collectMetadata(plugin, locale, domains, {
          params,
        });
        return JSON.stringify(response);
      }
      case "metadata-domains": {
        return JSON.stringify(describeMetadataDomains(plugin));
      }
      case "metadata-subscribe": {
        const domain = typeof first.domain === "string" ? first.domain : "";
        const params =
          first.params && typeof first.params === "object"
            ? (first.params as Record<string, unknown>)
            : {};
        const intervalMs =
          typeof first.intervalMs === "number" &&
          Number.isFinite(first.intervalMs)
            ? first.intervalMs
            : undefined;
        const subscriptionId = `sub-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        const perScript =
          subscriptions.get(scriptId) ??
          new Map<string, MetadataSubscription>();
        subscriptions.set(scriptId, perScript);
        const subscription = await subscribeMetadata(
          plugin,
          locale,
          domain,
          (response) => {
            window.snow.pushClientScriptData(
              scriptId,
              subscriptionId,
              JSON.stringify(response),
            );
          },
          { params, intervalMs },
        );
        perScript.set(subscriptionId, subscription);
        return JSON.stringify({ subscriptionId });
      }
      case "metadata-unsubscribe": {
        const subscriptionId = typeof args[0] === "string" ? args[0] : "";
        const perScript = subscriptions.get(scriptId);
        const subscription = perScript?.get(subscriptionId);
        subscription?.unsubscribe();
        perScript?.delete(subscriptionId);
        return JSON.stringify(true);
      }
      case "__release": {
        releaseScript(scriptId);
        return JSON.stringify(true);
      }
      case "write-run": {
        const actionId =
          typeof first.actionId === "string" ? first.actionId : "";
        const params =
          first.params && typeof first.params === "object"
            ? (first.params as Record<string, unknown>)
            : {};
        const response = await executeWrite({
          plugin,
          locale,
          actionId,
          params,
        });
        return JSON.stringify(response);
      }
      case "write-domains": {
        return JSON.stringify(describeWriteDomains(plugin, locale));
      }
      default:
        throw new Error(`Unknown client script data method: ${method}`);
    }
  };

  window.snow.registerClientScriptApi(handler);

  return () => {
    window.snow.registerClientScriptApi(null);
    for (const scriptId of Array.from(subscriptions.keys())) {
      releaseScript(scriptId);
    }
  };
};
