import type { PluginRuntimeApi, PluginWriteApi } from "./pluginApi";
import { WRITE_ACTION_IDS } from "./writes";

export type PluginChatInputActionResult = {
  message?: string;
  preview?: string;
  apply?: () => Promise<PluginChatInputActionResult>;
  undo?: () => Promise<void>;
};

export type PluginChatInputActionContext = {
  api: PluginRuntimeApi;
  signal: AbortSignal;
  onStatus: (message: string) => void;
  confirm: (message: string) => Promise<boolean>;
};

export type PluginChatInputAction = (
  context: PluginChatInputActionContext,
) => Promise<PluginChatInputActionResult>;

export const assertPluginActionActive = (signal: AbortSignal): void => {
  if (signal.aborted) throw new DOMException("Action cancelled", "AbortError");
};

/** Scope a fresh API instance to this action, not to the configuration panel.
 * Late, non-cooperative plugin continuations cannot start AI or write drafts.
 * All write calls retain the standard response shape and privacy checks.
 */
export const scopePluginActionApi = (
  api: PluginRuntimeApi,
  signal: AbortSignal,
  isCurrent: () => boolean,
): PluginRuntimeApi => {
  const check = (): void => {
    assertPluginActionActive(signal);
    if (!isCurrent())
      throw new DOMException("Action context changed", "AbortError");
  };
  const run: PluginWriteApi["run"] = async (actionId, params) => {
    if (signal.aborted || !isCurrent()) {
      return {
        ok: false,
        action: actionId,
        error: "Action cancelled or context changed",
      };
    }
    return api.write.run(actionId, params);
  };
  const write: Record<string, unknown> = { run, domains: api.write.domains };
  for (const id of WRITE_ACTION_IDS) {
    const separator = id.indexOf(".");
    const domain = id.slice(0, separator);
    const action = id.slice(separator + 1);
    const group = (write[domain] ?? {}) as Record<string, unknown>;
    group[action] = (params?: Record<string, unknown>) => run(id, params);
    write[domain] = group;
  }
  return {
    ...api,
    write: write as PluginWriteApi,
    ai: api.ai.optimizePrompt
      ? {
          optimizePrompt: async (options) => {
            check();
            const result = await api.ai.optimizePrompt!({
              ...options,
              signal: options.signal
                ? AbortSignal.any([signal, options.signal])
                : signal,
              onChunk: (delta) => {
                if (!signal.aborted && isCurrent()) options.onChunk?.(delta);
              },
            });
            check();
            return result;
          },
        }
      : {},
  };
};
