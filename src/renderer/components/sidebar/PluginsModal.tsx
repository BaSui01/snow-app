import {
  FolderOpen,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Upload,
  Puzzle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { resolveLocalized } from "../../plugins/manifest";
import type { PluginView, SensitiveScope } from "../../plugins/types";
import { pluginStore, usePluginStore } from "../../plugins/pluginStore";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Modal } from "../common/Modal";
import { PluginIcon } from "../common/PluginIcon";

type PluginsModalProps = {
  open: boolean;
  onClose: () => void;
};

export const PluginsModal = ({
  open,
  onClose,
}: PluginsModalProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const state = usePluginStore();
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<PluginView | null>(
    null,
  );
  const [isUninstalling, setIsUninstalling] = useState(false);

  useEffect(() => {
    if (open) {
      void pluginStore.refresh();
    }
  }, [open]);

  const handleInstall = useCallback(async () => {
    setIsInstalling(true);
    setError(null);
    try {
      const installed = await pluginStore.installFromDialog(
        t("plugins.installDialogTitle", {
          defaultValue: "Select plugin directory",
        }),
      );
      if (installed) {
        setError(null);
      }
    } catch (installError) {
      setError(
        installError instanceof Error
          ? installError.message
          : String(installError),
      );
    } finally {
      setIsInstalling(false);
    }
  }, [t]);

  const handleToggleEnabled = useCallback(async (plugin: PluginView) => {
    setBusyPluginId(plugin.pluginId);
    setError(null);
    try {
      await pluginStore.setEnabled(plugin.pluginId, !plugin.enabled);
    } catch (toggleError) {
      setError(
        toggleError instanceof Error
          ? toggleError.message
          : String(toggleError),
      );
    } finally {
      setBusyPluginId(null);
    }
  }, []);

  const handleRescan = useCallback(async (plugin: PluginView) => {
    setBusyPluginId(plugin.pluginId);
    setError(null);
    try {
      await pluginStore.rescan(plugin.pluginId);
    } catch (rescanError) {
      setError(
        rescanError instanceof Error
          ? rescanError.message
          : String(rescanError),
      );
    } finally {
      setBusyPluginId(null);
    }
  }, []);

  const confirmUninstall = useCallback(async () => {
    if (!pendingUninstall) {
      return;
    }
    setIsUninstalling(true);
    setError(null);
    try {
      await pluginStore.uninstall(pendingUninstall.pluginId, true);
      setPendingUninstall(null);
    } catch (uninstallError) {
      setError(
        uninstallError instanceof Error
          ? uninstallError.message
          : String(uninstallError),
      );
    } finally {
      setIsUninstalling(false);
    }
  }, [pendingUninstall]);

  const handleOpenFolder = useCallback(
    async (plugin: PluginView) => {
      try {
        await window.snow.showItemInFolder(plugin.installPath);
      } catch {
        try {
          await window.snow.openStorageDirectory(plugin.installPath);
        } catch {
          setError(
            t("plugins.openFolderFailed", {
              defaultValue: "Failed to open the plugin folder",
            }),
          );
        }
      }
    },
    [t],
  );

  const scopeLabel = (scope: SensitiveScope): string =>
    t(`plugins.scopes.${scope}`, { defaultValue: scope });

  const renderScopeTags = (plugin: PluginView): React.JSX.Element | null => {
    if (plugin.privacy.length === 0) {
      return null;
    }
    return (
      <div className="plugins-privacy-tags">
        <ShieldAlert size={12} strokeWidth={1.8} />
        {plugin.privacy.map((scope) => (
          <span className="plugins-privacy-tag" key={scope}>
            {scopeLabel(scope)}
          </span>
        ))}
      </div>
    );
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={t("plugins.title", { defaultValue: "Plugins" })}
        description={t("plugins.description", {
          defaultValue: "Install local plugin directories to extend Snow App.",
        })}
        closeLabel={t("common.close", { defaultValue: "Close" })}
        size="large"
        className="plugins-modal"
        closeOnEscape
      >
        <div className="plugins-modal-body">
          <div className="plugins-toolbar">
            <button
              className="plugins-toolbar-btn primary"
              type="button"
              disabled={isInstalling}
              onClick={() => void handleInstall()}
            >
              <Upload size={14} strokeWidth={1.8} />
              <span>
                {isInstalling
                  ? t("plugins.installing", { defaultValue: "Installing…" })
                  : t("plugins.install", {
                      defaultValue: "Install from folder",
                    })}
              </span>
            </button>
            <button
              className="plugins-toolbar-btn"
              type="button"
              onClick={() => void pluginStore.refresh()}
            >
              <RefreshCw size={14} strokeWidth={1.8} />
              <span>{t("plugins.refresh", { defaultValue: "Refresh" })}</span>
            </button>
          </div>

          {error && <div className="plugins-error">{error}</div>}

          {state.status === "loading" && state.plugins.length === 0 && (
            <div className="plugins-empty">
              {t("plugins.loading", { defaultValue: "Loading…" })}
            </div>
          )}

          {state.status === "ready" && state.plugins.length === 0 && (
            <div className="plugins-empty">
              <Puzzle size={22} strokeWidth={1.6} />
              <span>
                {t("plugins.empty", {
                  defaultValue: "No plugins installed yet",
                })}
              </span>
            </div>
          )}

          <div className="plugins-list">
            {state.plugins.map((plugin) => {
              const isBusy = busyPluginId === plugin.pluginId;
              return (
                <div className="plugins-item" key={plugin.pluginId}>
                  <div className="plugins-item-head">
                    <span className="plugins-item-icon">
                      <PluginIcon
                        pluginId={plugin.pluginId}
                        icon={plugin.icon}
                        size={18}
                      />
                    </span>
                    <div className="plugins-item-title">
                      <span className="plugins-item-name">
                        {resolveLocalized(plugin.name, locale) ||
                          plugin.pluginId}
                      </span>
                      <span className="plugins-item-meta">
                        v{plugin.version}
                        {plugin.author ? ` · ${plugin.author}` : ""}
                        {` · ${plugin.renderMode}`}
                      </span>
                    </div>
                    <div className="plugins-item-actions">
                      <button
                        className="plugins-toggle"
                        type="button"
                        role="switch"
                        aria-checked={plugin.enabled}
                        disabled={isBusy}
                        onClick={() => void handleToggleEnabled(plugin)}
                        title={
                          plugin.enabled
                            ? t("plugins.disable", { defaultValue: "Disable" })
                            : t("plugins.enable", { defaultValue: "Enable" })
                        }
                      >
                        <span
                          className={`plugins-toggle-track${
                            plugin.enabled ? " on" : ""
                          }`}
                        >
                          <span className="plugins-toggle-thumb" />
                        </span>
                      </button>
                      <button
                        className="plugins-icon-btn"
                        type="button"
                        disabled={isBusy}
                        title={t("plugins.rescan", {
                          defaultValue: "Reload manifest",
                        })}
                        onClick={() => void handleRescan(plugin)}
                      >
                        <RefreshCw size={13} strokeWidth={1.8} />
                      </button>
                      <button
                        className="plugins-icon-btn"
                        type="button"
                        title={t("plugins.openFolder", {
                          defaultValue: "Show in folder",
                        })}
                        onClick={() => void handleOpenFolder(plugin)}
                      >
                        <FolderOpen size={13} strokeWidth={1.8} />
                      </button>
                      <button
                        className="plugins-icon-btn danger"
                        type="button"
                        disabled={isBusy}
                        title={t("plugins.uninstall", {
                          defaultValue: "Uninstall",
                        })}
                        onClick={() => setPendingUninstall(plugin)}
                      >
                        <Trash2 size={13} strokeWidth={1.8} />
                      </button>
                    </div>
                  </div>

                  {plugin.description.default ||
                  Object.keys(plugin.description).length > 0 ? (
                    <div className="plugins-item-description">
                      {resolveLocalized(plugin.description, locale)}
                    </div>
                  ) : null}

                  {renderScopeTags(plugin)}

                  {plugin.privacyNote && (
                    <div className="plugins-privacy-note">
                      {plugin.privacyNote}
                    </div>
                  )}

                  <div className="plugins-item-path" title={plugin.installPath}>
                    {plugin.installPath}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingUninstall !== null}
        title={t("plugins.uninstallTitle", {
          defaultValue: "Uninstall plugin",
        })}
        message={t("plugins.uninstallMessage", {
          values: {
            name: pendingUninstall
              ? resolveLocalized(pendingUninstall.name, locale) ||
                pendingUninstall.pluginId
              : "",
          },
          defaultValue:
            "Remove “{{name}}” and delete its plugin folder? This cannot be undone.",
        })}
        confirmLabel={t("plugins.uninstall", { defaultValue: "Uninstall" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        isConfirming={isUninstalling}
        onConfirm={() => void confirmUninstall()}
        onCancel={() => setPendingUninstall(null)}
      />
    </>
  );
};
