import { AlertTriangle } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useI18n } from "../../i18n";
import {
  createPluginApi,
  type PluginRuntimeApi,
} from "../../plugins/pluginApi";
import { loadPluginMessages, resolveLocalized } from "../../plugins/manifest";
import { pluginStore, usePluginStore } from "../../plugins/pluginStore";
import {
  createIframePanel,
  injectPluginStyles,
  loadLucideIcons,
  loadPluginModule,
  mountPluginDom,
  resolvePluginComponent,
  type MountedPanel,
  type PluginModuleExports,
} from "../../plugins/pluginRuntime";
import { runtimeSnapshot } from "../../plugins/runtimeSnapshot";
import { createElement } from "react";

type PluginPanelContentProps = {
  pluginId: string;
  panelId: string;
  isActive: boolean;
};

const subscribeRuntimeSnapshot = (listener: () => void): (() => void) =>
  runtimeSnapshot.subscribe(() => listener());

const readChatInputText = (): string =>
  runtimeSnapshot.get().chatInput?.inputText ?? "";

/** 插件面板宿主：ESM（React 组件 / DOM 挂载）与 iframe 沙箱两种模式。 */
export const PluginPanelContent = ({
  pluginId,
  panelId,
  isActive,
}: PluginPanelContentProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const store = usePluginStore();
  const plugin = useMemo(
    () => store.plugins.find((item) => item.pluginId === pluginId) ?? null,
    [store.plugins, pluginId],
  );
  const panel = useMemo(
    () => plugin?.panels.find((item) => item.id === panelId) ?? null,
    [plugin, panelId],
  );

  const [api, setApi] = useState<PluginRuntimeApi | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [module, setModule] = useState<PluginModuleExports | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const domContainerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const entry = panel?.entry || plugin?.entry || "";

  const inputText = useSyncExternalStore(
    subscribeRuntimeSnapshot,
    readChatInputText,
    readChatInputText,
  );

  useEffect(() => {
    void pluginStore.ensureLoaded();
  }, []);

  useEffect(() => {
    if (!plugin) {
      return undefined;
    }
    let disposed = false;
    setError(null);
    setModule(null);
    setApi(null);

    void (async () => {
      try {
        const pluginMessages = await loadPluginMessages(plugin, locale);
        const icons = await loadLucideIcons();
        const runtimeApi = await createPluginApi({
          plugin,
          locale,
          messages: pluginMessages,
          icons,
        });
        if (disposed) {
          return;
        }
        setMessages(pluginMessages);
        setApi(runtimeApi);

        if (plugin.renderMode === "esm") {
          const loaded = await loadPluginModule({
            plugin,
            entry,
            api: runtimeApi,
            locale,
          });
          if (!disposed) {
            setModule(loaded);
          }
        } else {
          setModule({});
        }
      } catch (loadError) {
        if (!disposed) {
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [plugin, entry, locale, retryToken]);

  useEffect(() => {
    if (!plugin || plugin.renderMode !== "esm") {
      return undefined;
    }
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void injectPluginStyles(plugin).then((release) => {
      if (disposed) {
        release();
        return;
      }
      cleanup = release;
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [plugin]);

  const reactComponent = module ? resolvePluginComponent(module) : null;
  const usesDomMode = Boolean(module) && !reactComponent;

  useEffect(() => {
    if (!plugin || !module || !api || !usesDomMode) {
      return undefined;
    }
    const container = domContainerRef.current;
    if (!container) {
      return undefined;
    }
    let mounted: MountedPanel | null = null;
    try {
      mounted = mountPluginDom(module, container, api);
    } catch (mountError) {
      setError(
        mountError instanceof Error ? mountError.message : String(mountError),
      );
      return undefined;
    }
    if (!mounted) {
      setError(
        t("plugins.panel.entryInvalid", {
          defaultValue:
            "Plugin entry must export a React component as default or a mount(container, api) function",
        }),
      );
      return undefined;
    }
    return () => {
      mounted?.cleanup();
      container.replaceChildren();
    };
  }, [plugin, module, api, usesDomMode, t]);

  useEffect(() => {
    if (!plugin || plugin.renderMode !== "iframe" || !api) {
      return undefined;
    }
    const iframe = iframeRef.current;
    if (!iframe) {
      return undefined;
    }
    let disposed = false;
    let mounted: MountedPanel | null = null;
    void createIframePanel({
      iframe,
      plugin,
      entry,
      api,
      locale,
      messages,
    })
      .then((result) => {
        if (disposed) {
          result.cleanup();
          return;
        }
        mounted = result;
      })
      .catch((mountError) => {
        if (!disposed) {
          setError(
            mountError instanceof Error
              ? mountError.message
              : String(mountError),
          );
        }
      });
    return () => {
      disposed = true;
      mounted?.cleanup();
    };
  }, [plugin, api, entry, locale, messages]);

  const handleRetry = useCallback(() => {
    setRetryToken((token) => token + 1);
  }, []);

  if (!plugin) {
    return (
      <div className="plugin-panel-placeholder">
        {t("plugins.panel.missing", {
          defaultValue: "Plugin is no longer installed",
        })}
      </div>
    );
  }

  if (!plugin.enabled) {
    return (
      <div className="plugin-panel-placeholder">
        {t("plugins.panel.disabled", {
          defaultValue: "Plugin is disabled",
        })}
      </div>
    );
  }

  const panelTitle = panel
    ? resolveLocalized(panel.title, locale)
    : plugin.pluginId;

  if (error) {
    return (
      <div className="plugin-panel-error">
        <AlertTriangle size={18} strokeWidth={1.8} />
        <div className="plugin-panel-error-title">
          {t("plugins.panel.loadFailed", {
            defaultValue: "Failed to load plugin panel",
          })}
        </div>
        <div className="plugin-panel-error-detail">{error}</div>
        <button
          className="plugin-panel-retry"
          type="button"
          onClick={handleRetry}
        >
          {t("common.retry", { defaultValue: "Retry" })}
        </button>
      </div>
    );
  }

  if (plugin.renderMode === "iframe") {
    return (
      <iframe
        ref={iframeRef}
        className="plugin-panel-iframe"
        title={panelTitle}
      />
    );
  }

  if (!module || !api) {
    return <div className="plugin-panel-placeholder">…</div>;
  }

  if (reactComponent) {
    return (
      <div className="plugin-panel-root" data-plugin-id={plugin.pluginId}>
        {createElement(
          reactComponent as React.ComponentType<Record<string, unknown>>,
          {
            api,
            inputText,
            locale,
            panelId,
            panel: panel ?? null,
            pluginId: plugin.pluginId,
            isActive,
          },
        )}
      </div>
    );
  }

  return (
    <div
      ref={domContainerRef}
      className="plugin-panel-root"
      data-plugin-id={plugin.pluginId}
    />
  );
};
