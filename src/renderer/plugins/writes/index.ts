import type { Locale } from "../../../shared/locale";
import type { PluginView } from "../types";
import { WRITE_ACTIONS } from "./domains";
import type {
  PluginWriteActionDefinition,
  PluginWriteDomainSummary,
  PluginWriteParams,
  PluginWriteResponse,
} from "./types";

const actionIndex = new Map<string, PluginWriteActionDefinition>(
  WRITE_ACTIONS.map((definition) => [
    `${definition.domain}.${definition.action}`,
    definition,
  ]),
);

export const WRITE_ACTION_IDS: string[] = Array.from(actionIndex.keys());

export const describeWriteDomains = (
  plugin: PluginView,
  locale: Locale,
): PluginWriteDomainSummary[] => {
  const granted = new Set(plugin.privacy);
  const domains = new Map<string, PluginWriteDomainSummary>();
  for (const definition of WRITE_ACTIONS) {
    const id = `${definition.domain}.${definition.action}`;
    const allowed = !definition.scope || granted.has(definition.scope);
    let domain = domains.get(definition.domain);
    if (!domain) {
      domain = { id: definition.domain, granted: true, actions: [] };
      domains.set(definition.domain, domain);
    }
    domain.actions.push({
      id,
      scope: definition.scope,
      granted: allowed,
      summary: definition.summary[locale] ?? definition.summary.en ?? id,
    });
    if (!allowed) {
      domain.granted = false;
    }
  }
  return Array.from(domains.values());
};

const auditWrite = (
  pluginId: string,
  actionId: string,
  ok: boolean,
  error?: string,
): void => {
  const entry = {
    pluginId,
    action: actionId,
    ok,
    error: error ?? null,
    at: new Date().toISOString(),
  };
  console.log(
    `[plugin-write:${pluginId}] ${actionId} ${ok ? "ok" : "failed"}`,
    entry,
  );
  try {
    void Promise.resolve(window.snow.writeLog("info", entry)).catch(
      () => undefined,
    );
  } catch {
    // Logging must never break the write path.
  }
};

export const executeWrite = async (params: {
  plugin: PluginView;
  locale: Locale;
  actionId: string;
  params?: PluginWriteParams;
  log?: (...args: unknown[]) => void;
}): Promise<PluginWriteResponse> => {
  const { plugin, locale, actionId } = params;
  const definition = actionIndex.get(actionId);
  if (!definition) {
    return {
      ok: false,
      action: actionId,
      denied: { reason: "unknown-action" },
      error: `Unknown write action '${actionId}'`,
    };
  }

  if (definition.scope && !plugin.privacy.includes(definition.scope)) {
    return {
      ok: false,
      action: actionId,
      denied: {
        reason: "write-declaration-missing",
        scope: definition.scope,
      },
      error: `Declare '${definition.scope}' in the plugin privacy scopes to use '${actionId}'`,
    };
  }

  try {
    const data = await definition.invoke({
      plugin,
      locale,
      params: params.params ?? {},
      log:
        params.log ??
        ((...args: unknown[]) => {
          console.log(`[plugin:${plugin.pluginId}]`, ...args);
        }),
    });
    auditWrite(plugin.pluginId, actionId, true);
    return { ok: true, action: actionId, data: data ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    auditWrite(plugin.pluginId, actionId, false, message);
    console.error(`Plugin write action '${actionId}' failed`, error);
    return { ok: false, action: actionId, error: message };
  }
};
