import { RotateCcw, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { useI18n } from "../../i18n";
import { CustomSelect } from "../common/CustomSelect";
import { useDebouncedAutoSave } from "../../hooks/useDebouncedAutoSave";
import type { PrivacyApiConfig, PrivacySettings } from "../../../preload";

const PRIVACY_TOOL_LEGACY_MAP: Record<string, string> = {
  mcp__filesystem__read: "filesystem-read",
  mcp__grep__search: "grep-search",
  "mcp__bash__terminal-execute": "bash-terminal-execute",
  mcp__codebase__search: "codebase-search",
  "mcp__websearch__websearch-search": "websearch-websearch-search",
  "mcp__websearch__websearch-fetch": "websearch-websearch-fetch",
};

const migratePrivacyToolName = (tool: string): string =>
  PRIVACY_TOOL_LEGACY_MAP[tool] ?? tool;

const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  enabled: false,
  mode: "local",
  api: {
    url: "",
    apiKey: "",
    model: "openai/privacy-filter",
  },
  toolResults: {
    tools: ["filesystem-read", "grep-search", "bash-terminal-execute"],
  },
};

const PRIVACY_MODE_OPTIONS = [
  { value: "local", labelKey: "settings.privacyModeLocal" },
  { value: "api", labelKey: "settings.privacyModeApi" },
];

type ToolOption = {
  value: string;
  labelKey: string;
  defaultLabel: string;
};

const TOOL_OPTIONS: ToolOption[] = [
  {
    value: "filesystem-read",
    labelKey: "settings.privacyToolFilesystem",
    defaultLabel: "Filesystem",
  },
  {
    value: "grep-search",
    labelKey: "settings.privacyToolSearch",
    defaultLabel: "Search",
  },
  {
    value: "bash-terminal-execute",
    labelKey: "settings.privacyToolTerminal",
    defaultLabel: "Terminal",
  },
  {
    value: "codebase-search",
    labelKey: "settings.privacyToolCodebase",
    defaultLabel: "Codebase",
  },
  {
    value: "websearch-websearch-search",
    labelKey: "settings.privacyToolWebsearch",
    defaultLabel: "Web search",
  },
  {
    value: "websearch-websearch-fetch",
    labelKey: "settings.privacyToolWebfetch",
    defaultLabel: "Web fetch",
  },
];

const SAVE_DEBOUNCE_MS = 600;

/**
 * 计算待保存的隐私设置值。
 * 返回 null 表示无需保存（加载中 / 与上次保存一致）。
 */
function computePrivacySaveValue(
  form: PrivacySettings,
  lastSaved: PrivacySettings,
  isLoading: boolean,
): PrivacySettings | null {
  if (isLoading) {
    return null;
  }
  if (JSON.stringify(form) === JSON.stringify(lastSaved)) {
    return null;
  }
  return form;
}

type PrivacySettingsPanelProps = {
  onClose?: () => void;
};

export function PrivacySettingsPanel({
  onClose,
}: PrivacySettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [form, setForm] = useState<PrivacySettings>(DEFAULT_PRIVACY_SETTINGS);
  const [lastSaved, setLastSaved] = useState<PrivacySettings>(
    DEFAULT_PRIVACY_SETTINGS,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
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
      const value = await window.snow.getPrivacySettings();
      const normalized = normalizePrivacySettings(value);
      setForm(normalized);
      setLastSaved(normalized);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.privacyLoadError", {
              defaultValue: "Failed to load privacy settings",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const isBusy = isLoading || isSaving;

  const modeOptions = useMemo(
    () =>
      PRIVACY_MODE_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey, {
          defaultValue: option.value === "local" ? "Local rules" : "Online API",
        }),
      })),
    [t],
  );

  const updateEnabled = (enabled: boolean): void => {
    setForm((previous: PrivacySettings) => ({ ...previous, enabled }));
  };

  const updateMode = (mode: string): void => {
    setForm((previous: PrivacySettings) => ({ ...previous, mode }));
  };

  const updateApiField =
    (field: keyof PrivacyApiConfig) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const value = event.target.value;
      setForm((previous: PrivacySettings) => ({
        ...previous,
        api: { ...previous.api, [field]: value },
      }));
    };

  const toggleTool = (tool: string): void => {
    setForm((previous: PrivacySettings) => {
      const tools = new Set(previous.toolResults.tools);
      if (tools.has(tool)) {
        tools.delete(tool);
      } else {
        tools.add(tool);
      }
      return {
        ...previous,
        toolResults: { tools: Array.from(tools) },
      };
    });
  };

  const saveSettings = useCallback(
    async (settings: PrivacySettings) => {
      setIsSaving(true);
      setError("");
      try {
        const normalized = normalizePrivacySettings(settings);
        await window.snow.setPrivacySettings(normalized);
        if (isMountedRef.current) {
          setForm(normalized);
          setLastSaved(normalized);
          setStatus(
            t("settings.privacySaveSuccess", {
              defaultValue: "Privacy settings saved.",
            }),
          );
        }
      } catch (e) {
        if (isMountedRef.current) {
          setError(
            e instanceof Error
              ? e.message
              : t("settings.privacySaveError", {
                  defaultValue: "Failed to save privacy settings",
                }),
          );
        }
      } finally {
        if (isMountedRef.current) {
          setIsSaving(false);
        }
      }
    },
    [t],
  );

  // 修改即保存：表单变化后 debounce 保存，卸载时立即冲刷避免丢失。
  const saveValue = useMemo(
    () => computePrivacySaveValue(form, lastSaved, isLoading),
    [form, lastSaved, isLoading],
  );
  useDebouncedAutoSave(saveValue, saveSettings, SAVE_DEBOUNCE_MS);

  const handleReset = (): void => {
    setForm(DEFAULT_PRIVACY_SETTINGS);
    setError("");
    setStatus("");
    // 立即持久化默认隐私设置，避免 debounce 窗口内退出导致保存丢失。
    void saveSettings(DEFAULT_PRIVACY_SETTINGS);
  };

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.privacyTitle", {
              defaultValue: "Privacy settings",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.privacySettingsInfo", {
              defaultValue: "Redact sensitive data from tool results.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.privacyClosePanel", {
              defaultValue: "Close privacy settings",
            })}
            title={t("settings.privacyClosePanel", {
              defaultValue: "Close privacy settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>
            {t("settings.privacyManualTitle", {
              defaultValue: "Filter configuration",
            })}
          </strong>
          <span>
            {t("settings.privacyManualInfo", {
              defaultValue:
                "These values are stored locally and used to redact tool results before they are sent to the model.",
            })}
          </span>
        </div>

        <div className="api-settings-form-body">
          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.privacyEnable", {
                  defaultValue: "Enable privacy filter",
                })}
              </strong>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => updateEnabled(event.target.checked)}
                  disabled={isBusy}
                  hidden
                />
                <span className="toggle-slider" />
                <span>
                  {form.enabled
                    ? t("settings.enabled", { defaultValue: "Enabled" })
                    : t("settings.disabled", {
                        defaultValue: "Disabled",
                      })}
                </span>
              </label>
            </div>
            <span className="settings-item-description">
              {t("settings.privacyEnableInfo", {
                defaultValue:
                  "Redact sensitive data (API keys, tokens, IDs, cards) from selected tool results before sending to the model.",
              })}
            </span>
          </div>

          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.privacyMode", {
                  defaultValue: "Filter mode",
                })}
              </strong>
            </div>
            <div className="api-settings-form-grid">
              <CustomSelect
                value={form.mode}
                options={modeOptions}
                onChange={updateMode}
                disabled={isBusy}
              />
            </div>
            <span className="settings-item-description">
              {form.mode === "api"
                ? t("settings.privacyModeApiInfo", {
                    defaultValue:
                      "Send tool results to a configured privacy filter API for redaction.",
                  })
                : t("settings.privacyModeLocalInfo", {
                    defaultValue:
                      "Use built-in Rust regex rules for redaction. No external service required.",
                  })}
            </span>
          </div>

          {form.mode === "api" && (
            <div className="api-settings-form-section">
              <div className="api-settings-form-section-header">
                <strong className="api-settings-form-section-title">
                  {t("settings.privacyApiConfig", {
                    defaultValue: "API configuration",
                  })}
                </strong>
              </div>
              <span className="settings-item-description">
                {t("settings.privacyApiConfigInfo", {
                  defaultValue:
                    "Configure the online privacy filter API endpoint.",
                })}
              </span>
              <div className="api-settings-form-grid">
                <label className="api-settings-field wide">
                  <span>
                    {t("settings.privacyUrlLabel", {
                      defaultValue: "URL",
                    })}
                  </span>
                  <input
                    value={form.api.url}
                    onChange={updateApiField("url")}
                    placeholder={t("settings.privacyUrlPlaceholder", {
                      defaultValue: "https://example.com/privacy-filter",
                    })}
                    disabled={isBusy}
                  />
                </label>
                <label className="api-settings-field wide">
                  <span>
                    {t("settings.privacyApiKeyLabel", {
                      defaultValue: "API key (optional)",
                    })}
                  </span>
                  <input
                    value={form.api.apiKey}
                    onChange={updateApiField("apiKey")}
                    placeholder={t("settings.privacyApiKeyPlaceholder", {
                      defaultValue: "Leave empty if not required",
                    })}
                    type="password"
                    disabled={isBusy}
                  />
                </label>
                <label className="api-settings-field wide">
                  <span>
                    {t("settings.privacyModelLabel", {
                      defaultValue: "Model",
                    })}
                  </span>
                  <input
                    value={form.api.model}
                    onChange={updateApiField("model")}
                    placeholder={t("settings.privacyModelPlaceholder", {
                      defaultValue: "openai/privacy-filter",
                    })}
                    disabled={isBusy}
                  />
                </label>
              </div>
            </div>
          )}

          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.privacyToolResults", {
                  defaultValue: "Tool results to filter",
                })}
              </strong>
            </div>
            <span className="settings-item-description">
              {t("settings.privacyToolResultsInfo", {
                defaultValue:
                  "Select which tool results should be redacted before reaching the model.",
              })}
            </span>
            <div className="api-settings-form-grid">
              {TOOL_OPTIONS.map((option) => {
                const checked = form.toolResults.tools.includes(option.value);
                return (
                  <label key={option.value} className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleTool(option.value)}
                      disabled={isBusy}
                      hidden
                    />
                    <span className="toggle-slider" />
                    <span>
                      {t(option.labelKey, {
                        defaultValue: option.defaultLabel,
                      })}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        <div className="api-settings-form-actions">
          <button
            className="api-settings-form-btn secondary"
            onClick={handleReset}
            type="button"
            disabled={isBusy}
          >
            <RotateCcw size={15} strokeWidth={1.9} />
            <span>{t("settings.reset", { defaultValue: "Reset" })}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toText = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const normalizePrivacySettings = (value: unknown): PrivacySettings => {
  const source = isRecord(value) ? value : {};
  const apiSource = isRecord(source.api) ? source.api : {};
  const toolResultsSource = isRecord(source.toolResults)
    ? source.toolResults
    : {};

  const tools = Array.isArray(toolResultsSource.tools)
    ? toolResultsSource.tools
        .map((tool) =>
          typeof tool === "string" ? migratePrivacyToolName(tool.trim()) : "",
        )
        .filter((tool) => tool.length > 0)
    : DEFAULT_PRIVACY_SETTINGS.toolResults.tools;

  const mode = toText(source.mode).trim() || DEFAULT_PRIVACY_SETTINGS.mode;

  return {
    enabled:
      typeof source.enabled === "boolean"
        ? source.enabled
        : DEFAULT_PRIVACY_SETTINGS.enabled,
    mode,
    api: {
      url: toText(apiSource.url).trim(),
      apiKey: toText(apiSource.apiKey).trim(),
      model:
        toText(apiSource.model).trim() || DEFAULT_PRIVACY_SETTINGS.api.model,
    },
    toolResults: { tools },
  };
};
