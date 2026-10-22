import { Loader2, Package, Puzzle, Store } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "../../common/Modal";
import { useI18n } from "../../../i18n";
import type { OAuthProviderInfo } from "../../../../preload";
import {
  openMainView,
  requestPluginsPanelNavigation,
} from "../../../plugins/panelNavigation";
import { OAuthProviderIcon } from "./OAuthProviderIcon";
import {
  oauthProviderDescription,
  oauthProviderLabel,
} from "./oauthProviderText";

type OAuthProviderPickerProps = {
  open: boolean;
  providers: OAuthProviderInfo[];
  isLoading: boolean;
  onSelect: (provider: OAuthProviderInfo) => void;
  onClose: () => void;
};

type ProviderSource = "builtin" | "plugin";

export function OAuthProviderPicker({
  open,
  providers,
  isLoading,
  onSelect,
  onClose,
}: OAuthProviderPickerProps): React.JSX.Element {
  const { t } = useI18n();
  const [source, setSource] = useState<ProviderSource>("builtin");

  const builtinProviders = useMemo(
    () => providers.filter((provider) => !provider.pluginId),
    [providers],
  );
  const pluginProviders = useMemo(
    () => providers.filter((provider) => provider.pluginId),
    [providers],
  );

  // 打开或列表刷新时默认落在有内容的来源
  useEffect(() => {
    if (!open) return;
    setSource(
      builtinProviders.length === 0 && pluginProviders.length > 0
        ? "plugin"
        : "builtin",
    );
  }, [open, builtinProviders.length, pluginProviders.length]);

  const visibleProviders =
    source === "builtin" ? builtinProviders : pluginProviders;

  const renderCards = (list: OAuthProviderInfo[]) => (
    <div className="oauth-provider-list">
      {list.map((provider) => (
        <button
          className="oauth-provider-card"
          key={provider.id}
          type="button"
          onClick={() => onSelect(provider)}
        >
          <span className="oauth-provider-card-head">
            <span className="oauth-provider-icon">
              <OAuthProviderIcon
                providerId={provider.id}
                iconUrl={provider.icon}
                size={22}
              />
            </span>
            <strong>{oauthProviderLabel(t, provider)}</strong>
          </span>
          <span className="oauth-provider-card-desc">
            {oauthProviderDescription(t, provider)}
          </span>
        </button>
      ))}
    </div>
  );

  const emptyHint =
    source === "builtin"
      ? t("settings.oauthBuiltinEmpty", {
          defaultValue: "No built-in OAuth provider is available.",
        })
      : t("settings.oauthPluginEmpty", {
          defaultValue: "No plugin provides an OAuth provider.",
        });

  const handleOpenPluginMarket = (): void => {
    requestPluginsPanelNavigation({ tab: "market", category: "oauth" });
    onClose();
    openMainView("plugins");
  };

  // 空态引导：提示可从插件市场安装 OAuth 插件
  const renderMarketShortcut = (title: string) => (
    <div className="oauth-provider-empty">
      <Puzzle size={22} strokeWidth={1.6} />
      <span className="oauth-provider-empty-title">{title}</span>
      <span className="oauth-provider-empty-hint">
        {t("settings.oauthPluginMarketHint", {
          defaultValue:
            "Install an OAuth plugin to add more sign-in providers.",
        })}
      </span>
      <button
        className="api-settings-form-btn primary"
        type="button"
        onClick={handleOpenPluginMarket}
      >
        <Store size={14} strokeWidth={1.8} />
        <span>
          {t("settings.oauthOpenPluginMarket", {
            defaultValue: "Open plugin market",
          })}
        </span>
      </button>
    </div>
  );

  return (
    <Modal
      open={open}
      title={t("settings.oauthPickTitle", {
        defaultValue: "Choose sign-in type",
      })}
      description={t("settings.oauthPickDescription", {
        defaultValue:
          "Pick the subscription service to connect, then complete the authorization in your browser.",
      })}
      closeLabel={t("settings.close", { defaultValue: "Close" })}
      onClose={onClose}
      className="oauth-provider-picker"
      footer={
        <button
          className="api-settings-form-btn secondary"
          type="button"
          onClick={onClose}
        >
          <span>{t("settings.close", { defaultValue: "Close" })}</span>
        </button>
      }
    >
      {isLoading ? (
        <div className="oauth-login-status">
          <Loader2 size={14} className="spin" />
          <span>
            {t("settings.oauthLoadingProviders", {
              defaultValue: "Loading available providers...",
            })}
          </span>
        </div>
      ) : providers.length === 0 ? (
        renderMarketShortcut(
          t("settings.oauthProviderMissing", {
            defaultValue: "No OAuth provider is available.",
          }),
        )
      ) : (
        <>
          <div className="import-settings-tabs" role="tablist">
            <button
              aria-selected={source === "builtin"}
              className={`import-settings-tab${source === "builtin" ? " active" : ""}`}
              onClick={() => setSource("builtin")}
              role="tab"
              type="button"
            >
              <Package size={14} />
              {t("settings.oauthSourceBuiltin", { defaultValue: "Built-in" })}
              <span className="oauth-provider-tab-count">
                {builtinProviders.length}
              </span>
            </button>
            <button
              aria-selected={source === "plugin"}
              className={`import-settings-tab${source === "plugin" ? " active" : ""}`}
              onClick={() => setSource("plugin")}
              role="tab"
              type="button"
            >
              <Puzzle size={14} />
              {t("settings.oauthSourcePlugin", { defaultValue: "Plugins" })}
              <span className="oauth-provider-tab-count">
                {pluginProviders.length}
              </span>
            </button>
          </div>
          {visibleProviders.length > 0 ? (
            renderCards(visibleProviders)
          ) : source === "plugin" ? (
            renderMarketShortcut(emptyHint)
          ) : (
            <p className="oauth-login-hint">{emptyHint}</p>
          )}
        </>
      )}
    </Modal>
  );
}
