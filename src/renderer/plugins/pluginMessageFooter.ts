import type { MetadataSubscription } from "./metadata";
import type { PluginMetadataApi, PluginRuntimeApi } from "./pluginApi";

export type PluginMessageFooterContext = Readonly<{
  slot: "message-footer";
  conversationId: string;
  messageId: string;
  directoryId: string | undefined;
}>;

/** Footer v1 deliberately does not expose write, AI, network or storage APIs. */
export type PluginMessageFooterApi = Pick<
  PluginRuntimeApi,
  | "id"
  | "version"
  | "name"
  | "installPath"
  | "locale"
  | "t"
  | "assets"
  | "ui"
  | "log"
> & { metadata: PluginMetadataApi };

export type PluginMessageFooterMount = (
  container: HTMLElement,
  api: PluginMessageFooterApi,
  context: PluginMessageFooterContext,
  signal: AbortSignal,
) => void | (() => void) | { unmount: () => void };

/** Own subscriptions, including promises resolving after the footer was removed. */
export const scopePluginMessageFooterApi = (
  source: PluginRuntimeApi,
  context: PluginMessageFooterContext,
  signal: AbortSignal,
  isCurrent: () => boolean,
): PluginMessageFooterApi => {
  const subscriptions = new Set<MetadataSubscription>();
  const pending = new Set<Promise<MetadataSubscription>>();
  const released = new WeakSet<MetadataSubscription>();
  const active = (): boolean => !signal.aborted && isCurrent();
  const check = (): void => {
    if (!active())
      throw new DOMException("Footer context expired", "AbortError");
  };
  const release = (subscription: MetadataSubscription): void => {
    if (released.has(subscription)) return;
    released.add(subscription);
    subscriptions.delete(subscription);
    try {
      subscription.unsubscribe();
    } catch {
      console.warn("Plugin footer subscription cleanup failed");
    }
  };
  signal.addEventListener(
    "abort",
    () => {
      for (const subscription of subscriptions) release(subscription);
    },
    { once: true },
  );
  const optionsFor = <T extends { params?: Record<string, unknown> }>(
    options?: T,
  ) => ({
    ...options,
    params: {
      conversationId: context.conversationId,
      ...(context.directoryId ? { directoryId: context.directoryId } : {}),
      ...options?.params,
    },
  });
  return Object.freeze({
    id: source.id,
    version: source.version,
    name: source.name,
    installPath: source.installPath,
    locale: source.locale,
    t: (key, options) => {
      check();
      return source.t(key, options);
    },
    log: (...args) => {
      if (active()) source.log(...args);
    },
    ui: Object.freeze({
      messageFooterVersion: 1 as const,
      React: source.ui.React,
      icon: (name: string) => {
        check();
        return source.ui.icon(name);
      },
    }),
    assets: Object.freeze({
      resolve: async (path: string) => {
        check();
        const result = await source.assets.resolve(path);
        check();
        return result;
      },
    }),
    metadata: Object.freeze({
      domains: () => {
        check();
        return source.metadata.domains();
      },
      get: async (domain, options) => {
        check();
        const result = await source.metadata.get(domain, optionsFor(options));
        check();
        return result;
      },
      subscribe: async (domain, listener, options) => {
        check();
        const promise = source.metadata.subscribe(
          domain,
          (response) => {
            if (!active()) return;
            try {
              listener(response);
            } catch {
              console.warn("Plugin footer metadata listener failed");
            }
          },
          optionsFor(options),
        );
        pending.add(promise);
        let subscription: MetadataSubscription;
        try {
          subscription = await promise;
        } finally {
          pending.delete(promise);
        }
        if (!active()) {
          release(subscription);
          check();
        }
        subscriptions.add(subscription);
        let released = false;
        return {
          unsubscribe: () => {
            if (released) return;
            released = true;
            release(subscription);
          },
        };
      },
    } satisfies PluginMetadataApi),
  } satisfies PluginMessageFooterApi);
};
