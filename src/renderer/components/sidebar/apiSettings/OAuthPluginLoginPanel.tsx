import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import type {
  OAuthLoginStart,
  OAuthLoginStatus,
  OAuthProviderInfo,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import {
  createPluginApi,
  type PluginOAuthLoginApi,
  type PluginOAuthSession,
  type PluginOAuthStatus,
  type PluginRuntimeApi,
} from "../../../plugins/pluginApi";
import { loadPluginMessages } from "../../../plugins/manifest";
import { pluginStore, usePluginStore } from "../../../plugins/pluginStore";
import {
  createIframePanel,
  injectPluginStyles,
  loadLucideIcons,
  loadPluginModule,
  mountPluginDom,
  resolvePluginComponent,
  type MountedPanel,
  type PluginModuleExports,
} from "../../../plugins/pluginRuntime";

type OAuthPluginLoginPanelProps = {
  provider: OAuthProviderInfo;
  session: OAuthLoginStart;
  status: OAuthLoginStatus | null;
  onStatus: (status: OAuthLoginStatus) => void;
};

/** OAuth 登录弹窗内的插件自定义面板（ESM / DOM / iframe）。 */
export function OAuthPluginLoginPanel({
  provider,
  session,
  status,
  onStatus,
}: OAuthPluginLoginPanelProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const store = usePluginStore();
  const plugin = useMemo(
    () =>
      store.plugins.find((item) => item.pluginId === provider.pluginId) ?? null,
    [store.plugins, provider.pluginId],
  );
  const [api, setApi] = useState<PluginRuntimeApi | null>(null);
  const [module, setModule] = useState<PluginModuleExports | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const listenersRef = useRef(new Set<(next: PluginOAuthStatus) => void>());
  const onStatusRef = useRef(onStatus);
  const mountedRef = useRef<MountedPanel | null>(null);
  const domContainerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  const entry = provider.panelEntry || plugin?.entry || "";

  const pluginSession = useMemo(() => {
    if (!session.pluginSession) {
      return undefined;
    }
    try {
      return JSON.parse(session.pluginSession) as unknown;
    } catch {
      return undefined;
    }
  }, [session.pluginSession]);

  const oauthSession = useMemo<PluginOAuthSession>(
    () => ({
      sessionId: session.sessionId,
      providerId: provider.id,
      flow: session.flow,
      authUrl: session.authUrl,
      redirectUri: session.redirectUri,
      state: session.state,
      nonce: session.nonce,
      codeChallenge: session.codeChallenge,
      codeVerifier: session.codeVerifier,
      userCode: session.userCode ?? "",
      instructions: session.instructions ?? "",
      manualMode: session.manualMode,
      pluginSession,
    }),
    [session, provider.id, pluginSession],
  );

  const publishStatus = useCallback((next: PluginOAuthStatus) => {
    onStatusRef.current(next as OAuthLoginStatus);
  }, []);

  const oauth = useMemo<PluginOAuthLoginApi>(
    () => ({
      session: oauthSession,
      status: () =>
        window.snow.getOAuthLoginStatus(
          session.sessionId,
        ) as Promise<PluginOAuthStatus | null>,
      submitCallback: async (callbackUrl) => {
        const next = await window.snow.submitOAuthCallback(
          session.sessionId,
          callbackUrl,
        );
        publishStatus(next);
        return next;
      },
      submitTokens: async (tokens) => {
        const next = await window.snow.submitOAuthLoginTokens(
          session.sessionId,
          tokens,
        );
        publishStatus(next);
        return next;
      },
      openBrowser: (url) => {
        const target = (url ?? "").trim() || session.authUrl;
        if (target) {
          window.open(target, "_blank", "noopener,noreferrer");
        }
      },
      cancel: () => window.snow.cancelOAuthLogin(session.sessionId),
      onStatus: (listener) => {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
    }),
    [oauthSession, session.sessionId, session.authUrl, publishStatus],
  );

  useEffect(() => {
    void pluginStore.ensureLoaded();
  }, []);

  useEffect(() => {
    if (!plugin || !entry) {
      return undefined;
    }
    let disposed = false;
    setError("");
    setModule(null);
    setApi(null);

    void (async () => {
      try {
        const [pluginMessages, icons] = await Promise.all([
          loadPluginMessages(plugin, locale),
          loadLucideIcons(),
        ]);
        const runtimeApi = await createPluginApi({
          plugin,
          locale,
          messages: pluginMessages,
          icons,
          oauth,
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
  }, [plugin, entry, locale, oauth, reloadToken]);

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

  // 宿主轮询到的状态同步给面板
  useEffect(() => {
    if (!status) {
      return;
    }
    for (const listener of listenersRef.current) {
      try {
        listener(status as PluginOAuthStatus);
      } catch {
        // 面板回调异常不影响宿主
      }
    }
    mountedRef.current?.notify?.("oauth.status", status);
  }, [status]);

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
        t("settings.oauthPanelInvalidEntry", {
          defaultValue:
            "The panel entry must export a React component or a mount(container, api) function",
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
      oauthSession: oauthSession as unknown as Record<string, unknown>,
    })
      .then((result) => {
        if (disposed) {
          result.cleanup();
          return;
        }
        mounted = result;
        mountedRef.current = result;
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
      mountedRef.current = null;
    };
  }, [plugin, api, entry, locale, messages, oauthSession]);

  if (store.status === "idle" || store.status === "loading") {
    return (
      <div className="oauth-login-status">
        <Loader2 size={14} className="spin" />
        <span>
          {t("settings.oauthPanelLoading", {
            defaultValue: "Loading the sign-in panel...",
          })}
        </span>
      </div>
    );
  }

  if (!plugin) {
    return (
      <div className="oauth-login-panel-state">
        {t("settings.oauthPanelPluginMissing", {
          defaultValue:
            "The plugin that provides this sign-in method is missing",
        })}
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="oauth-login-panel-state">
        {t("settings.oauthPanelInvalidEntry", {
          defaultValue:
            "The panel entry must export a React component or a mount(container, api) function",
        })}
      </div>
    );
  }

  if (error) {
    return (
      <div className="oauth-login-panel-error">
        <AlertTriangle size={18} strokeWidth={1.8} />
        <span>
          {t("settings.oauthPanelLoadFailed", {
            defaultValue: "Failed to load the sign-in panel",
          })}
        </span>
        <code>{error}</code>
        <button
          className="api-settings-action-btn secondary"
          type="button"
          onClick={() => setReloadToken((token) => token + 1)}
        >
          <RefreshCw size={14} />
          <span>
            {t("settings.oauthPanelReload", { defaultValue: "Reload" })}
          </span>
        </button>
      </div>
    );
  }

  if (plugin.renderMode === "iframe") {
    return (
      <iframe
        ref={iframeRef}
        className="oauth-login-panel-iframe"
        title={provider.panelTitle || provider.displayName}
      />
    );
  }

  if (!module || !api) {
    return (
      <div className="oauth-login-status">
        <Loader2 size={14} className="spin" />
        <span>
          {t("settings.oauthPanelLoading", {
            defaultValue: "Loading the sign-in panel...",
          })}
        </span>
      </div>
    );
  }

  if (reactComponent) {
    return (
      <div className="oauth-login-panel" data-plugin-id={plugin.pluginId}>
        {createElement(
          reactComponent as React.ComponentType<Record<string, unknown>>,
          {
            api,
            oauth: api.oauth,
            session: oauthSession,
            status,
            locale,
            pluginId: plugin.pluginId,
            providerId: provider.id,
          },
        )}
      </div>
    );
  }

  return (
    <div
      ref={domContainerRef}
      className="oauth-login-panel"
      data-plugin-id={plugin.pluginId}
    />
  );
}
