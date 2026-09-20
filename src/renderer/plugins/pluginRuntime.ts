import * as ReactNamespace from "react";

import type { Locale } from "../../shared/locale";
import bridgeSource from "./pluginIframeBridge.js?raw";
import type { PluginMetadataApi, PluginRuntimeApi } from "./pluginApi";
import type { MetadataResponse, PluginView } from "./types";

export type PluginModuleExports = {
  default?: unknown;
  mount?: (
    container: HTMLElement,
    api: PluginRuntimeApi
  ) => void | (() => void) | { unmount?: () => void };
  render?: PluginModuleExports["mount"];
  unmount?: () => void;
};

let lucideIcons: Record<string, unknown> | null = null;

/** lucide 图标命名空间（按需加载，仅插件面板使用）。 */
export const loadLucideIcons = async (): Promise<Record<string, unknown>> => {
  if (lucideIcons) {
    return lucideIcons;
  }
  try {
    const module = (await import("lucide-react")) as unknown as Record<
      string,
      unknown
    >;
    lucideIcons = module;
  } catch (error) {
    console.warn("Failed to load lucide icons for plugins", error);
    lucideIcons = {};
  }
  return lucideIcons;
};

export const injectPluginStyles = async (
  plugin: PluginView
): Promise<() => void> => {
  const elements: HTMLStyleElement[] = [];
  for (const relativePath of plugin.styles) {
    try {
      const css = await window.snow.readPluginFile(
        plugin.pluginId,
        relativePath
      );
      const element = document.createElement("style");
      element.dataset.snowPlugin = plugin.pluginId;
      element.textContent = css;
      document.head.appendChild(element);
      elements.push(element);
    } catch (error) {
      console.warn(
        `Failed to load plugin style '${relativePath}' (${plugin.pluginId})`,
        error
      );
    }
  }
  return () => {
    for (const element of elements) {
      element.remove();
    }
  };
};

/** 以 ESM 方式加载插件代码：注入 React / 图标 / API 后动态 import。 */
export const loadPluginModule = async (params: {
  plugin: PluginView;
  entry: string;
  api: PluginRuntimeApi;
  locale: Locale;
}): Promise<PluginModuleExports> => {
  const { plugin, entry, api, locale } = params;
  const source = await window.snow.readPluginFile(plugin.pluginId, entry);
  const icons = await loadLucideIcons();

  const scope = window as unknown as Record<string, unknown>;
  scope.SnowAppPlugin = {
    React: ReactNamespace,
    createElement: ReactNamespace.createElement,
    api,
    icons,
    locale,
    plugin: {
      id: plugin.pluginId,
      version: plugin.version,
      installPath: plugin.installPath,
    },
  };

  const blob = new Blob([source], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    const module = (await import(/* @vite-ignore */ url)) as PluginModuleExports;
    return module;
  } finally {
    URL.revokeObjectURL(url);
  }
};

const isMountFunction = (
  value: unknown
): value is NonNullable<PluginModuleExports["mount"]> =>
  typeof value === "function";

export type MountedPanel = {
  mode: "dom" | "react" | "iframe";
  cleanup: () => void;
};

/** 以 DOM 方式挂载插件（module.mount / module.render / default.mount）。 */
export const mountPluginDom = (
  module: PluginModuleExports,
  container: HTMLElement,
  api: PluginRuntimeApi
): MountedPanel | null => {
  const defaultExport = module.default;
  const mount = isMountFunction(module.mount)
    ? module.mount
    : isMountFunction(module.render)
      ? module.render
      : defaultExport &&
          typeof defaultExport === "object" &&
          isMountFunction((defaultExport as PluginModuleExports).mount)
        ? (defaultExport as PluginModuleExports).mount
        : null;

  if (!mount) {
    return null;
  }

  const result = mount(container, api);
  const cleanup = (): void => {
    if (typeof result === "function") {
      result();
      return;
    }
    if (
      result &&
      typeof result === "object" &&
      typeof result.unmount === "function"
    ) {
      result.unmount();
      return;
    }
    if (typeof module.unmount === "function") {
      module.unmount();
    }
  };

  return { mode: "dom", cleanup };
};

/** JSX/TSX 组件形式的面板导出（default 为函数）。 */
export const resolvePluginComponent = (
  module: PluginModuleExports
): ((props: Record<string, unknown>) => unknown) | null =>
  typeof module.default === "function"
    ? (module.default as (props: Record<string, unknown>) => unknown)
    : null;

const buildIframeDocument = (params: {
  bridgeUrl: string;
  scriptUrl: string;
  stylesCss: string;
  title: string;
}): string => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${params.title}</title>
<style>${params.stylesCss}</style>
</head>
<body>
<div id="snow-plugin-root"></div>
<script src="${params.bridgeUrl}"></script>
<script src="${params.scriptUrl}"></script>
</body>
</html>`;

const resolveConfigForIframe = (params: {
  plugin: PluginView;
  locale: Locale;
  messages: Record<string, string>;
}): string => {
  const { plugin, locale, messages } = params;
  return JSON.stringify({
    pluginId: plugin.pluginId,
    name: plugin.name[locale] ?? plugin.name.default ?? plugin.pluginId,
    version: plugin.version,
    locale,
    messages,
  });
};

type IframeRequest = {
  source: "snow-plugin";
  id: number;
  type: string;
  payload?: Record<string, unknown>;
};

const handleMetadataGet = (
  api: PluginRuntimeApi,
  payload: Record<string, unknown> | undefined
): Promise<MetadataResponse> => {
  const raw = payload?.domain;
  const domain = Array.isArray(raw)
    ? (raw as string[])
    : typeof raw === "string"
      ? [raw]
      : [];
  const options = (payload?.options ?? {}) as {
    params?: Record<string, unknown>;
  };
  return api.metadata.get(domain, options);
};

const createIframeSubscriptionHandler = (
  iframe: HTMLIFrameElement,
  api: PluginRuntimeApi,
  registry: Map<string, { unsubscribe: () => void }>
) => {
  const post = (message: Record<string, unknown>): void => {
    iframe.contentWindow?.postMessage(message, "*");
  };

  return async (
    payload: Record<string, unknown> | undefined
  ): Promise<{ subscriptionId: string }> => {
    const domain = typeof payload?.domain === "string" ? payload.domain : "";
    const options = (payload?.options ?? {}) as Parameters<
      PluginMetadataApi["subscribe"]
    >[2];
    const subscriptionId = `sub-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const subscription = await api.metadata.subscribe(
      domain,
      (response) => {
        post({
          source: "snow-plugin-host",
          type: "metadata",
          subscriptionId,
          payload: response,
        });
      },
      options ?? {}
    );
    registry.set(subscriptionId, subscription);
    return { subscriptionId };
  };
};

/** iframe 沙箱面板：独立文档 + postMessage 元数据桥。 */
export const createIframePanel = async (params: {
  iframe: HTMLIFrameElement;
  plugin: PluginView;
  entry: string;
  api: PluginRuntimeApi;
  locale: Locale;
  messages: Record<string, string>;
}): Promise<MountedPanel> => {
  const { iframe, plugin, entry, api, locale, messages } = params;
  const stylesCss = (
    await Promise.all(
      plugin.styles.map((style) =>
        window.snow.readPluginFile(plugin.pluginId, style).catch(() => "")
      )
    )
  ).join("\n");

  const pluginSource = await window.snow.readPluginFile(plugin.pluginId, entry);
  const pluginUrl = URL.createObjectURL(
    new Blob([pluginSource], { type: "text/javascript" })
  );

  const bridgeCode = bridgeSource.replace(
    "__SNOW_PLUGIN_CONFIG__",
    resolveConfigForIframe({ plugin, locale, messages })
  );
  const bridgeUrl = URL.createObjectURL(
    new Blob([bridgeCode], { type: "text/javascript" })
  );

  const documentUrl = URL.createObjectURL(
    new Blob(
      [
        buildIframeDocument({
          bridgeUrl,
          scriptUrl: pluginUrl,
          stylesCss,
          title: plugin.name[locale] ?? plugin.name.default ?? plugin.pluginId,
        }),
      ],
      { type: "text/html" }
    )
  );

  const subscriptions = new Map<string, { unsubscribe: () => void }>();
  const subscribe = createIframeSubscriptionHandler(iframe, api, subscriptions);

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) {
      return;
    }
    const data = event.data as IframeRequest | undefined;
    if (!data || typeof data !== "object" || data.source !== "snow-plugin") {
      return;
    }
    const reply = (message: Record<string, unknown>): void => {
      iframe.contentWindow?.postMessage(message, "*");
    };

    void (async () => {
      try {
        const payload = data.payload;
        let result: unknown;
        switch (data.type) {
          case "metadata.get":
            result = await handleMetadataGet(api, payload);
            break;
          case "metadata.domains":
            result = api.metadata.domains();
            break;
          case "metadata.subscribe":
            result = await subscribe(payload);
            break;
          case "metadata.unsubscribe": {
            const subscriptionId =
              typeof payload?.subscriptionId === "string"
                ? payload.subscriptionId
                : "";
            subscriptions.get(subscriptionId)?.unsubscribe();
            subscriptions.delete(subscriptionId);
            result = true;
            break;
          }
          case "storage.get": {
            const key = typeof payload?.key === "string" ? payload.key : "";
            result = await api.storage.get(key);
            break;
          }
          case "storage.set": {
            const key = typeof payload?.key === "string" ? payload.key : "";
            const value =
              typeof payload?.value === "string"
                ? payload.value
                : JSON.stringify(payload?.value ?? null);
            await api.storage.set(key, value);
            result = true;
            break;
          }
          case "storage.remove": {
            const key = typeof payload?.key === "string" ? payload.key : "";
            await api.storage.remove(key);
            result = true;
            break;
          }
          case "storage.all":
            result = await api.storage.all();
            break;
          case "assets.resolve": {
            const relativePath =
              typeof payload?.path === "string" ? payload.path : "";
            result = await api.assets.resolve(relativePath);
            break;
          }
          default:
            throw new Error(`Unsupported plugin request '${data.type}'`);
        }
        reply({
          source: "snow-plugin-host",
          type: "response",
          id: data.id,
          ok: true,
          result,
        });
      } catch (error) {
        reply({
          source: "snow-plugin-host",
          type: "response",
          id: data.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  };

  window.addEventListener("message", onMessage);
  iframe.src = documentUrl;

  return {
    mode: "iframe",
    cleanup: () => {
      window.removeEventListener("message", onMessage);
      for (const subscription of subscriptions.values()) {
        subscription.unsubscribe();
      }
      subscriptions.clear();
      URL.revokeObjectURL(documentUrl);
      URL.revokeObjectURL(pluginUrl);
      URL.revokeObjectURL(bridgeUrl);
    },
  };
};
