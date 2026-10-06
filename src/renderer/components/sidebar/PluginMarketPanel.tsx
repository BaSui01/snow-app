import {
  Download,
  Loader2,
  Puzzle,
  RefreshCw,
  Search,
  ShieldAlert,
  Store,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { resolveLocalized, resolvePluginIcon } from "../../plugins/manifest";
import {
  buildMarketDownloadUrl,
  hasMarketUpdate,
  isMarketEntryTooNew,
  PLUGIN_MARKET_REPO_URL,
  type MarketPluginEntry,
} from "../../plugins/market";
import { marketStore, useMarketStore } from "../../plugins/marketStore";
import {
  resolveLucideIcon,
  type LucideIconComponent,
} from "../../plugins/pluginRuntime";
import { pluginStore, usePluginStore } from "../../plugins/pluginStore";
import { isSensitiveScope, type PluginView } from "../../plugins/types";
import type { UserscriptRecord } from "../../../preload/types/userscripts";
import { Modal } from "../common/Modal";
import { PluginPrivacyBadges } from "./PluginPrivacyBadges";
import {
  PluginPrivacyDialog,
  type PluginPrivacyTarget,
} from "./PluginPrivacyDialog";

/** 市场条目图标：lucide:Name 解析为对应图标，其余回退为占位图标。 */
const MarketEntryIcon = ({ icon }: { icon: string }): React.JSX.Element => {
  const [lucideIcon, setLucideIcon] = useState<LucideIconComponent | null>(
    null,
  );

  useEffect(() => {
    let disposed = false;
    setLucideIcon(null);
    const resolved = resolvePluginIcon(icon);
    if (resolved?.kind === "lucide") {
      void resolveLucideIcon(resolved.name).then((found) => {
        if (!disposed) {
          setLucideIcon(found);
        }
      });
    }
    return () => {
      disposed = true;
    };
  }, [icon]);

  if (lucideIcon) {
    const Icon = lucideIcon;
    return (
      <span className="plugin-icon">
        <Icon size={18} />
      </span>
    );
  }
  return (
    <span className="plugin-icon">
      <Puzzle size={18} />
    </span>
  );
};

export const PluginMarketPanel = (): React.JSX.Element => {
  const { t, locale } = useI18n();
  const pluginState = usePluginStore();
  const market = useMarketStore();
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [pendingEntry, setPendingEntry] = useState<MarketPluginEntry | null>(
    null,
  );
  const [privacyTarget, setPrivacyTarget] =
    useState<PluginPrivacyTarget | null>(null);
  const [userscripts, setUserscripts] = useState<UserscriptRecord[]>([]);

  const refreshUserscripts = useCallback((): void => {
    void window.snow
      .listUserscripts()
      .then(setUserscripts)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void marketStore.ensureLoaded();
    refreshUserscripts();
    return window.snow.onUserscriptsChanged(refreshUserscripts);
  }, [refreshUserscripts]);

  const installedById = useMemo(() => {
    const map = new Map<string, PluginView>();
    for (const plugin of pluginState.plugins) {
      map.set(plugin.pluginId, plugin);
    }
    return map;
  }, [pluginState.plugins]);

  const findInstalled = useCallback(
    (entry: MarketPluginEntry): { version: string } | null => {
      if (entry.kind === "script") {
        const script = userscripts.find((item) => item.scriptId === entry.id);
        return script ? { version: script.version } : null;
      }
      const plugin = installedById.get(entry.id);
      return plugin ? { version: plugin.version } : null;
    },
    [installedById, userscripts],
  );

  const filteredEntries = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return market.entries;
    }
    return market.entries.filter((entry) => {
      const haystack = [
        entry.id,
        resolveLocalized(entry.name, locale),
        resolveLocalized(entry.description, locale),
        entry.author,
        ...entry.tags,
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }, [market.entries, locale, query]);

  const openPrivacy = useCallback(
    (entry: MarketPluginEntry): void => {
      setPrivacyTarget({
        name: resolveLocalized(entry.name, locale) || entry.id,
        source: "plugin",
        scopes: entry.privacy.filter(isSensitiveScope),
        note: "",
      });
    },
    [locale],
  );

  const confirmInstall = useCallback(async (): Promise<void> => {
    if (!pendingEntry) {
      return;
    }
    setBusyId(pendingEntry.id);
    setInstallError(null);
    try {
      await pluginStore.installFromMarket(pendingEntry);
      setPendingEntry(null);
    } catch (installFailure) {
      setInstallError(
        installFailure instanceof Error
          ? installFailure.message
          : String(installFailure),
      );
    } finally {
      setBusyId(null);
    }
  }, [pendingEntry]);

  const isBusy = busyId !== null;
  const pendingDownloadUrl = pendingEntry
    ? buildMarketDownloadUrl(pendingEntry)
    : null;

  return (
    <div className="plugins-tab-content">
      <div className="plugins-toolbar">
        <div className="plugin-market-search">
          <Search size={13} strokeWidth={1.8} />
          <input
            className="plugin-market-search-input"
            type="search"
            value={query}
            placeholder={t("plugins.market.searchPlaceholder", {
              defaultValue: "Search plugins…",
            })}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button
          className="plugins-toolbar-btn"
          type="button"
          disabled={market.status === "loading"}
          onClick={() => void marketStore.refresh()}
        >
          <RefreshCw size={14} strokeWidth={1.8} />
          <span>{t("plugins.refresh", { defaultValue: "Refresh" })}</span>
        </button>
      </div>

      <div className="plugin-market-source">
        <Store size={12} strokeWidth={1.8} />
        <span>{t("plugins.market.source", { defaultValue: "Source" })}:</span>
        <button
          className="plugin-market-source-link"
          type="button"
          onClick={() => window.open(PLUGIN_MARKET_REPO_URL, "_blank")}
        >
          {PLUGIN_MARKET_REPO_URL.replace("https://github.com/", "")}
        </button>
        {market.updatedAt ? (
          <span className="plugin-market-updated">
            {t("plugins.market.updatedAt", {
              values: { time: market.updatedAt },
              defaultValue: "Updated {{time}}",
            })}
          </span>
        ) : null}
      </div>

      {market.status === "error" && (
        <div className="plugins-empty">
          <ShieldAlert size={22} strokeWidth={1.6} />
          <span>
            {t("plugins.market.loadError", {
              defaultValue: "Failed to load the plugin market",
            })}
          </span>
          {market.error ? (
            <span className="plugins-empty-hint">{market.error}</span>
          ) : null}
          <button
            className="plugins-toolbar-btn"
            type="button"
            onClick={() => void marketStore.refresh()}
          >
            <RefreshCw size={14} strokeWidth={1.8} />
            <span>{t("plugins.market.retry", { defaultValue: "Retry" })}</span>
          </button>
        </div>
      )}

      {market.status === "loading" && market.entries.length === 0 && (
        <div className="plugins-empty">
          <Loader2 size={20} className="spin" />
          <span>{t("plugins.loading", { defaultValue: "Loading…" })}</span>
        </div>
      )}

      {market.status === "ready" && filteredEntries.length === 0 && (
        <div className="plugins-empty">
          <Store size={22} strokeWidth={1.6} />
          <span>
            {market.entries.length === 0
              ? t("plugins.market.empty", {
                  defaultValue: "No plugins in the market yet",
                })
              : t("plugins.market.noMatch", {
                  defaultValue: "No matching plugins",
                })}
          </span>
        </div>
      )}

      <div className="plugins-list">
        {filteredEntries.map((entry) => {
          const installed = findInstalled(entry);
          const downloadUrl = buildMarketDownloadUrl(entry);
          const tooNew = isMarketEntryTooNew(entry, market.appVersion);
          const isUpdate =
            installed !== null &&
            hasMarketUpdate(installed.version, entry.version);
          const isCurrent = installed !== null && !isUpdate;
          const entryBusy = busyId === entry.id;
          return (
            <div className="plugins-item plugin-market-item" key={entry.id}>
              <div className="plugins-item-head">
                <span className="plugins-item-icon">
                  <MarketEntryIcon icon={entry.icon} />
                </span>
                <div className="plugins-item-title">
                  <span className="plugins-item-name">
                    {resolveLocalized(entry.name, locale) || entry.id}
                  </span>
                  <span className="plugins-item-meta">
                    v{entry.version}
                    {entry.author ? ` · ${entry.author}` : ""}
                    {entry.kind === "script"
                      ? ` · ${t("plugins.market.kindScript", {
                          defaultValue: "Script",
                        })}`
                      : ""}
                    {entry.tags.length > 0
                      ? ` · ${entry.tags.join(" / ")}`
                      : ""}
                  </span>
                </div>
                <div className="plugins-item-actions">
                  {isCurrent ? (
                    <span className="plugin-market-installed">
                      {t("plugins.market.installed", {
                        defaultValue: "Installed",
                      })}
                    </span>
                  ) : (
                    <button
                      className="plugins-toolbar-btn primary"
                      type="button"
                      disabled={entryBusy || tooNew || !downloadUrl}
                      title={
                        tooNew
                          ? t("plugins.market.requiresApp", {
                              values: { version: entry.minAppVersion },
                              defaultValue:
                                "Requires app v{{version}} or newer",
                            })
                          : undefined
                      }
                      onClick={() => {
                        setInstallError(null);
                        setPendingEntry(entry);
                      }}
                    >
                      {entryBusy ? (
                        <Loader2 size={14} className="spin" />
                      ) : (
                        <Download size={13} strokeWidth={1.8} />
                      )}
                      <span>
                        {isUpdate
                          ? t("plugins.market.update", {
                              defaultValue: "Update",
                            })
                          : t("plugins.market.install", {
                              defaultValue: "Install",
                            })}
                      </span>
                    </button>
                  )}
                </div>
              </div>

              {resolveLocalized(entry.description, locale) ? (
                <div className="plugins-item-description">
                  {resolveLocalized(entry.description, locale)}
                </div>
              ) : null}

              <PluginPrivacyBadges
                scopes={entry.privacy.filter(isSensitiveScope)}
                onOpen={() => openPrivacy(entry)}
              />

              <div className="plugin-market-item-foot">
                {isUpdate ? (
                  <span className="plugin-market-update-hint">
                    {t("plugins.market.updateHint", {
                      values: {
                        from: installed?.version ?? "",
                        to: entry.version,
                      },
                      defaultValue: "Installed v{{from}} → v{{to}}",
                    })}
                  </span>
                ) : null}
                {tooNew ? (
                  <span className="plugin-market-requires">
                    {t("plugins.market.requiresApp", {
                      values: { version: entry.minAppVersion },
                      defaultValue: "Requires app v{{version}} or newer",
                    })}
                  </span>
                ) : null}
                <button
                  className="plugin-market-repo-link"
                  type="button"
                  onClick={() => window.open(entry.repo, "_blank")}
                >
                  {entry.repo.replace("https://github.com/", "")}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <Modal
        closeDisabled={isBusy}
        closeLabel={t("common.cancel", { defaultValue: "Cancel" })}
        closeOnEscape
        description={
          pendingEntry
            ? resolveLocalized(pendingEntry.name, locale) || pendingEntry.id
            : ""
        }
        open={pendingEntry !== null}
        size="medium"
        title={t("plugins.market.confirmTitle", {
          defaultValue: "Install plugin",
        })}
        footer={
          <>
            <button
              className="confirm-dialog-btn cancel"
              type="button"
              disabled={isBusy}
              onClick={() => setPendingEntry(null)}
            >
              {t("common.cancel", { defaultValue: "Cancel" })}
            </button>
            <button
              className="confirm-dialog-btn confirm"
              type="button"
              disabled={isBusy || !pendingDownloadUrl}
              onClick={() => void confirmInstall()}
            >
              {isBusy ? <Loader2 size={14} className="spin" /> : null}
              {isBusy
                ? t("plugins.market.installing", {
                    defaultValue: "Installing…",
                  })
                : pendingEntry && findInstalled(pendingEntry)
                  ? t("plugins.market.update", { defaultValue: "Update" })
                  : t("plugins.market.install", { defaultValue: "Install" })}
            </button>
          </>
        }
        onClose={() => {
          if (!isBusy) {
            setPendingEntry(null);
            setInstallError(null);
          }
        }}
      >
        {pendingEntry ? (
          <div className="plugin-market-confirm">
            <div className="plugin-market-confirm-meta">
              <span>v{pendingEntry.version}</span>
              {pendingEntry.author ? <span>{pendingEntry.author}</span> : null}
            </div>
            {resolveLocalized(pendingEntry.description, locale) ? (
              <p>{resolveLocalized(pendingEntry.description, locale)}</p>
            ) : null}
            <div className="plugin-market-confirm-row">
              <span>
                {t("plugins.market.source", { defaultValue: "Source" })}
              </span>
              <button
                className="plugin-market-repo-link"
                type="button"
                onClick={() => window.open(pendingEntry.repo, "_blank")}
              >
                {pendingEntry.repo.replace("https://github.com/", "")}
              </button>
            </div>
            <div className="plugin-market-confirm-row">
              <span>SHA256</span>
              <code className="plugin-market-hash">
                {pendingEntry.sha256.slice(0, 16)}…
              </code>
            </div>
            <PluginPrivacyBadges
              scopes={pendingEntry.privacy.filter(isSensitiveScope)}
              onOpen={() => openPrivacy(pendingEntry)}
            />
            {isMarketEntryTooNew(pendingEntry, market.appVersion) ? (
              <div className="plugin-market-requires">
                {t("plugins.market.requiresApp", {
                  values: { version: pendingEntry.minAppVersion },
                  defaultValue: "Requires app v{{version}} or newer",
                })}
              </div>
            ) : null}
            {installError ? (
              <div className="plugins-error">{installError}</div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <PluginPrivacyDialog
        target={privacyTarget}
        onClose={() => setPrivacyTarget(null)}
      />
    </div>
  );
};
