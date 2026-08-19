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
import { CodebaseSettingsForm } from "./codebaseSettings/CodebaseSettingsForm";
import { CodebaseSettingsSummary } from "./codebaseSettings/CodebaseSettingsSummary";
import {
  CODEBASE_SETTING_CODE,
  CODEBASE_SETTING_NAME,
  DEFAULT_CODEBASE_SETTINGS,
} from "./codebaseSettings/codebaseSettingsConstants";
import {
  normalizeCodebaseSettings,
  readCodebaseSettingsJson,
  toCodebaseForm,
  toCodebaseSettings,
} from "./codebaseSettings/codebaseSettingsUtils";
import type {
  CodebaseSettings,
  CodebaseSettingsForm as CodebaseSettingsFormValue,
  CodebaseSettingsPanelProps,
} from "./codebaseSettings/types";

export function CodebaseSettingsPanel({
  onClose,
}: CodebaseSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [form, setForm] = useState<CodebaseSettingsFormValue>(() =>
    toCodebaseForm(DEFAULT_CODEBASE_SETTINGS)
  );
  const [lastSaved, setLastSaved] = useState<CodebaseSettings>(
    DEFAULT_CODEBASE_SETTINGS
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
      const value = await window.snow.getSystemSettingValue(
        CODEBASE_SETTING_CODE
      );
      const normalized = normalizeCodebaseSettings(
        readCodebaseSettingsJson(value)
      );
      setForm(toCodebaseForm(normalized));
      setLastSaved(normalized);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.codebaseLoadError", {
              defaultValue: "Failed to load codebase settings",
            })
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const isBusy = isLoading || isSaving;
  const preview = toCodebaseSettings(form);

  const updateField =
    (field: keyof CodebaseSettingsFormValue) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value =
        event.target instanceof HTMLInputElement &&
        event.target.type === "checkbox"
          ? event.target.checked
          : event.target.value;

      setForm((previous) => ({ ...previous, [field]: value }));
    };

  const setValue = (field: keyof CodebaseSettingsFormValue, value: string) => {
    setForm((previous) => ({ ...previous, [field]: value }));
  };

  const validatePositiveInteger = (
    value: string,
    message: string
  ): string | null => {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? null : message;
  };

  const validate = useCallback(
    (currentForm: CodebaseSettingsFormValue): string | null => {
      if (!currentForm.embeddingModelName.trim()) {
        return t("settings.codebaseValidationModelNameRequired", {
          defaultValue:
            "Embedding model name is required when codebase is enabled.",
        });
      }

      if (!currentForm.embeddingBaseUrl.trim()) {
        return t("settings.codebaseValidationBaseUrlRequired", {
          defaultValue:
            "Embedding base URL is required when codebase is enabled.",
        });
      }

      const numericChecks: Array<[string, string]> = [
        [
          currentForm.embeddingDimensions,
          t("settings.codebaseValidationDimensionsPositive", {
            defaultValue: "Embedding dimensions must be greater than 0.",
          }),
        ],
        [
          currentForm.batchMaxLines,
          t("settings.codebaseValidationMaxLinesPositive", {
            defaultValue: "Batch max lines must be greater than 0.",
          }),
        ],
        [
          currentForm.batchConcurrency,
          t("settings.codebaseValidationConcurrencyPositive", {
            defaultValue: "Batch concurrency must be greater than 0.",
          }),
        ],
        [
          currentForm.chunkingMaxLinesPerChunk,
          t("settings.codebaseValidationMaxLinesPerChunkPositive", {
            defaultValue: "Max lines per chunk must be greater than 0.",
          }),
        ],
        [
          currentForm.chunkingMinLinesPerChunk,
          t("settings.codebaseValidationMinLinesPerChunkPositive", {
            defaultValue: "Min lines per chunk must be greater than 0.",
          }),
        ],
         [
           currentForm.modelContextLength,
           t("settings.codebaseValidationModelContextLengthPositive", {
             defaultValue: "Model context length must be greater than 0.",
           }),
         ],
       ];

      for (const [value, message] of numericChecks) {
        const validationError = validatePositiveInteger(value, message);

        if (validationError) {
          return validationError;
        }
      }

      const overlapLines = Number.parseInt(
        currentForm.chunkingOverlapLines,
        10
      );
      const maxLinesPerChunk = Number.parseInt(
        currentForm.chunkingMaxLinesPerChunk,
        10
      );

      if (!Number.isInteger(overlapLines) || overlapLines < 0) {
        return t("settings.codebaseValidationOverlapLinesNonNegative", {
          defaultValue: "Overlap lines must be 0 or greater.",
        });
      }

      if (
        Number.isInteger(maxLinesPerChunk) &&
        overlapLines >= maxLinesPerChunk
      ) {
        return t("settings.codebaseValidationOverlapLessThanMaxLines", {
          defaultValue: "Overlap lines must be less than max lines per chunk.",
        });
      }

      if (
        currentForm.rerankingModelName.trim() ||
        currentForm.rerankingBaseUrl.trim()
      ) {
        if (!currentForm.rerankingModelName.trim()) {
          return t("settings.codebaseValidationRerankingModelNameRequired", {
            defaultValue:
              "Reranking model name is required when reranking is enabled.",
          });
        }

        if (!currentForm.rerankingBaseUrl.trim()) {
          return t("settings.codebaseValidationRerankingBaseUrlRequired", {
            defaultValue:
              "Reranking base URL is required when reranking is enabled.",
          });
        }

        const contextLengthError = validatePositiveInteger(
          currentForm.rerankingContextLength,
          t("settings.codebaseValidationRerankingContextLengthPositive", {
            defaultValue: "Reranking context length must be greater than 0.",
          })
        );

        if (contextLengthError) {
          return contextLengthError;
        }

        const topNError = validatePositiveInteger(
          currentForm.rerankingTopN,
          t("settings.codebaseValidationRerankingTopNPositive", {
            defaultValue: "Reranking top N must be greater than 0.",
          })
        );

        if (topNError) {
          return topNError;
        }
      }

      return null;
    },
    [t]
  );

  const saveSettings = useCallback(
    async (settings: CodebaseSettings) => {
      setIsSaving(true);
      setError("");
      try {
        await window.snow.setSystemSetting(
          CODEBASE_SETTING_NAME,
          CODEBASE_SETTING_CODE,
          JSON.stringify(settings)
        );
        const normalized = normalizeCodebaseSettings(settings);
        if (isMountedRef.current) {
          setForm(toCodebaseForm(normalized));
          setLastSaved(normalized);
          setStatus(
            t("settings.codebaseSaveSuccess", {
              defaultValue: "Saved codebase settings.",
            })
          );
        }
      } catch (e) {
        if (isMountedRef.current) {
          setError(
            e instanceof Error
              ? e.message
              : t("settings.codebaseSaveError", {
                  defaultValue: "Failed to save codebase settings",
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
    toCodebaseSettings,
    lastSaved,
    saveSettings,
    setError
  );

  const handleImport = async () => {
    setIsLoading(true);
    setError("");
    setStatus("");

    try {
      const settings = await window.snow.importSnowCliCodebaseSettings();
      const normalized = normalizeCodebaseSettings(settings);
      setForm(toCodebaseForm(normalized));
      setLastSaved(normalized);
      setStatus(
        t("settings.codebaseImportSuccess", {
          defaultValue: "Synced codebase settings from Snow CLI.",
        })
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.codebaseImportError", {
              defaultValue: "Failed to sync Snow CLI codebase settings",
            })
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.codebaseTitle", {
              defaultValue: "Codebase settings",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.codebaseSettingsInfo", {
              defaultValue: "Manage indexing and workspace code search.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeCodebaseSettings", {
              defaultValue: "Close codebase settings",
            })}
            title={t("settings.closeCodebaseSettings", {
              defaultValue: "Close codebase settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <CodebaseSettingsSummary preview={preview} lastSaved={lastSaved} />

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
            {t("settings.syncSnowCliCodebase", {
              defaultValue: "Sync Snow CLI codebase config",
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

      <CodebaseSettingsForm
        form={form}
        isBusy={isBusy}
        onUpdateField={updateField}
        onSetValue={setValue}
        onBlurSave={commitSave}
        onReset={() => {
          const defaults = toCodebaseForm(DEFAULT_CODEBASE_SETTINGS);
          setForm(defaults);
          void saveSettings(DEFAULT_CODEBASE_SETTINGS);
        }}
      />
    </div>
  );
}
