import { Download, Loader2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { useI18n } from "../../i18n";
import { useBlurAutoSave } from "../../hooks/useBlurAutoSave";
import { ProxyBrowserSettingsForm } from "./proxyBrowserSettings/ProxyBrowserSettingsForm";
import { ProxyBrowserSettingsSummary } from "./proxyBrowserSettings/ProxyBrowserSettingsSummary";
import {
  DEFAULT_PROXY_BROWSER_SETTINGS,
  PROXY_BROWSER_SETTING_CODE,
  PROXY_BROWSER_SETTING_NAME,
  RECOMMENDED_BLOCKED_PATTERNS,
} from "./proxyBrowserSettings/proxyBrowserSettingsConstants";
import {
  normalizeProxyBrowserSettings,
  readProxyBrowserSettingsJson,
  toProxyBrowserForm,
  toProxyBrowserSettings,
} from "./proxyBrowserSettings/proxyBrowserSettingsUtils";
import type {
  ProxyBrowserSettingsForm as ProxyBrowserSettingsFormValue,
  ProxyBrowserSettingsPanelProps,
  ProxyBrowserSettingsValue,
} from "./proxyBrowserSettings/types";

export function ProxyBrowserSettingsPanel({
  onClose,
}: ProxyBrowserSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [form, setForm] = useState<ProxyBrowserSettingsFormValue>(() =>
    toProxyBrowserForm(DEFAULT_PROXY_BROWSER_SETTINGS)
  );
  const [lastSaved, setLastSaved] = useState<ProxyBrowserSettingsValue>(
    DEFAULT_PROXY_BROWSER_SETTINGS
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSelectingBrowser, setIsSelectingBrowser] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const value = await window.snow.getSystemSettingValue(
        PROXY_BROWSER_SETTING_CODE
      );
      const settings = readProxyBrowserSettingsJson(value);
      setForm(toProxyBrowserForm(settings));
      setLastSaved(settings);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.proxyBrowserLoadError", {
              defaultValue: "Failed to load proxy and browser settings",
            })
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const isBusy = isLoading || isSaving || isSelectingBrowser;
  const preview = toProxyBrowserSettings(form);

  const updateField =
    (field: keyof ProxyBrowserSettingsFormValue) =>
    (
      event: ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >
    ) => {
      const value =
        event.target instanceof HTMLInputElement &&
        event.target.type === "checkbox"
          ? event.target.checked
          : event.target.value;

      setForm((previous) => ({ ...previous, [field]: value }));
    };

  const setValue = (
    field: keyof ProxyBrowserSettingsFormValue,
    value: string
  ) => {
    setForm((previous) => ({ ...previous, [field]: value }));
  };

  const validate = useCallback(
    (currentForm: ProxyBrowserSettingsFormValue): string | null => {
      const proxyPort = Number.parseInt(currentForm.port, 10);
      const browserDebugPort = Number.parseInt(
        currentForm.browserDebugPort,
        10
      );

      if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
        return t("settings.proxyPortValidationError", {
          defaultValue: "Proxy port must be between 1 and 65535.",
        });
      }

      if (
        !Number.isInteger(browserDebugPort) ||
        browserDebugPort < 1 ||
        browserDebugPort > 65535
      ) {
        return t("settings.browserDebugPortValidationError", {
          defaultValue: "Browser debug port must be between 1 and 65535.",
        });
      }

      const invalidPattern = currentForm.blockedPatternsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .find((line) => {
          try {
            new RegExp(line);
            return false;
          } catch {
            return true;
          }
        });

      if (invalidPattern) {
        return t("settings.blockedPatternsValidationError", {
          defaultValue: "Invalid regex: {{pattern}}",
          values: { pattern: invalidPattern },
        });
      }

      return null;
    },
    [t]
  );

  const saveSettings = useCallback(
    async (settings: ProxyBrowserSettingsValue) => {
      setIsSaving(true);
      setError("");
      try {
        await window.snow.setSystemSetting(
          PROXY_BROWSER_SETTING_NAME,
          PROXY_BROWSER_SETTING_CODE,
          JSON.stringify(settings)
        );
        // 通知主进程重新应用会话代理（net.fetch / electron-updater）
        void window.snow.applyProxySettings();
        if (isMountedRef.current) {
          setLastSaved(settings);
          setStatus(
            t("settings.proxyBrowserSaveSuccess", {
              defaultValue: "Saved proxy and browser settings.",
            })
          );
        }
      } catch (e) {
        if (isMountedRef.current) {
          setError(
            e instanceof Error
              ? e.message
              : t("settings.proxyBrowserSaveError", {
                  defaultValue: "Failed to save proxy and browser settings",
                })
          );
        }
      } finally {
        if (isMountedRef.current) {
          setIsSaving(false);
        }
      }
    },
    [t]
  );

  // 失焦保存：输入框失焦或即时控件变更时立即保存，验证失败则不保存，卸载时立即冲刷避免丢失。
  const commitSave = useBlurAutoSave(
    form,
    validate,
    toProxyBrowserSettings,
    lastSaved,
    saveSettings,
    setError
  );

  const handleImport = async () => {
    setIsLoading(true);
    setError("");
    setStatus("");

    try {
      const settings = await window.snow.importSnowCliProxyConfig();
      const normalized = normalizeProxyBrowserSettings(settings);
      setForm(toProxyBrowserForm(normalized));
      setLastSaved(normalized);
      setStatus(
        t("settings.proxyBrowserImportSuccess", {
          defaultValue: "Synced proxy settings from Snow CLI.",
        })
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.proxyBrowserImportError", {
              defaultValue: "Failed to sync Snow CLI proxy settings",
            })
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleApplyRecommended = () => {
    const nextForm: ProxyBrowserSettingsFormValue = {
      ...form,
      blockedPatternsText: RECOMMENDED_BLOCKED_PATTERNS.join("\n"),
    };
    setForm(nextForm);
    commitSave(nextForm);
  };

  const handleSelectBrowserExecutable = async () => {
    setIsSelectingBrowser(true);
    setError("");
    setStatus("");

    try {
      const selectedPath = await window.snow.selectBrowserExecutable(
        t("settings.selectBrowserExecutableDialogTitle", {
          defaultValue: "Select browser executable",
        })
      );

      if (selectedPath) {
        setForm((previous) => ({ ...previous, browserPath: selectedPath }));
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.browserExecutableSelectError", {
              defaultValue: "Failed to select browser executable",
            })
      );
    } finally {
      setIsSelectingBrowser(false);
    }
  };

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.proxyBrowserTitle", {
              defaultValue: "Proxy and search engine",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.proxySettingsInfo", {
              defaultValue: "Configure HTTP proxy and network access.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeProxyBrowserSettings", {
              defaultValue: "Close proxy and browser settings",
            })}
            title={t("settings.closeProxyBrowserSettings", {
              defaultValue: "Close proxy and browser settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <ProxyBrowserSettingsSummary preview={preview} />

      <div className="api-settings-actions">
        <button
          className="api-settings-action-btn primary"
          onClick={() => void handleImport()}
          type="button"
          disabled={isBusy}
        >
          {isLoading ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <Download size={15} />
          )}
          <span>
            {t("settings.syncSnowCliProxy", {
              defaultValue: "Sync Snow CLI proxy config",
            })}
          </span>
        </button>
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <ProxyBrowserSettingsForm
        form={form}
        isBusy={isBusy}
        isSelectingBrowser={isSelectingBrowser}
        onUpdateField={updateField}
        onSetValue={setValue}
        onBlurSave={commitSave}
        onReset={() => {
          const defaults = toProxyBrowserForm(DEFAULT_PROXY_BROWSER_SETTINGS);
          setForm(defaults);
          void saveSettings(DEFAULT_PROXY_BROWSER_SETTINGS);
        }}
        onSelectBrowserExecutable={() => void handleSelectBrowserExecutable()}
        onApplyRecommended={handleApplyRecommended}
      />
    </div>
  );
}
