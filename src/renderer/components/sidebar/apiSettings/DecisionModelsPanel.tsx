import { Loader2, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../../i18n";
import {
  DECISION_MODELS_SETTING_CODE,
  DECISION_MODELS_SETTING_NAME,
  DEFAULT_DECISION_MODEL_BASE_URL,
  DEFAULT_DECISION_MODEL_MODEL,
  DEFAULT_DECISION_MODEL_NAME,
  createDecisionModel,
  readDecisionModelsJson,
  toDecisionModelsJson,
  type DecisionModelConfig,
} from "../../../constants/decisionModels";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { Modal } from "../../common/Modal";

/**
 * 决策模型管理面板（API 配置页的「决策模型」标签页）。
 *
 * 支持配置多个决策模型并单独启停：只有已启用的模型会出现在代码库代理审查等
 * 使用方的选择列表里。整份配置以 JSON 写入 system_settings 的 `decision_models`，
 * Rust 侧按同一份数据解析（native/src/api/jev.rs）。
 */
export function DecisionModelsPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [models, setModels] = useState<DecisionModelConfig[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  /** 编辑中的草稿（null = 编辑器关闭） */
  const [draft, setDraft] = useState<DecisionModelConfig | null>(null);
  /** 草稿是否为新建（决定编辑器标题与保存按钮文案） */
  const [isNewDraft, setIsNewDraft] = useState(false);
  /** 待确认删除的模型（null = 无） */
  const [pendingDelete, setPendingDelete] =
    useState<DecisionModelConfig | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const raw = await window.snow.getSystemSettingValue(
        DECISION_MODELS_SETTING_CODE,
      );
      setModels(readDecisionModelsJson(raw));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.decisionModelLoadError", {
              defaultValue: "Failed to load decision models",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 持久化整份配置（新增 / 编辑 / 启停 / 删除共用），返回是否成功。 */
  const persist = useCallback(
    async (
      next: DecisionModelConfig[],
      successMessage: string,
    ): Promise<boolean> => {
      setIsSaving(true);
      setError("");
      setStatus("");

      try {
        await window.snow.setSystemSetting(
          DECISION_MODELS_SETTING_NAME,
          DECISION_MODELS_SETTING_CODE,
          toDecisionModelsJson(next),
        );
        setModels(next);
        setStatus(successMessage);
        return true;
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.decisionModelSaveError", {
                defaultValue: "Failed to save decision models",
              }),
        );
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [t],
  );

  const openNewDraft = (): void => {
    setError("");
    setStatus("");
    setDraft(createDecisionModel());
    setIsNewDraft(true);
  };

  const openEditDraft = (model: DecisionModelConfig): void => {
    setError("");
    setStatus("");
    setDraft({ ...model });
    setIsNewDraft(false);
  };

  const closeDraft = (): void => {
    if (!isSaving) {
      setDraft(null);
    }
  };

  const updateDraft = (
    field: keyof DecisionModelConfig,
    value: string,
  ): void => {
    setDraft((previous) =>
      previous ? { ...previous, [field]: value } : previous,
    );
  };

  const saveDraft = async (): Promise<void> => {
    const current = draft;
    if (!current) {
      return;
    }

    if (!current.name.trim()) {
      setError(
        t("settings.decisionModelNameRequired", {
          defaultValue: "Name is required.",
        }),
      );
      return;
    }
    if (!current.baseUrl.trim()) {
      setError(
        t("settings.decisionModelBaseUrlRequired", {
          defaultValue: "Base URL is required.",
        }),
      );
      return;
    }
    if (!current.model.trim()) {
      setError(
        t("settings.decisionModelModelRequired", {
          defaultValue: "Model name is required.",
        }),
      );
      return;
    }

    const name = current.name.trim();
    const next = isNewDraft
      ? [...models, current]
      : models.map((model) => (model.id === current.id ? current : model));
    const saved = await persist(
      next,
      isNewDraft
        ? t("settings.decisionModelAddSuccess", {
            values: { name },
            defaultValue: `Added decision model ${name}.`,
          })
        : t("settings.decisionModelSaveSuccess", {
            values: { name },
            defaultValue: `Saved decision model ${name}.`,
          }),
    );

    if (saved) {
      setDraft(null);
    }
  };

  /** 启停单个模型：停用后使用方（如代码库代理审查）不再能选到它。 */
  const toggleEnabled = async (model: DecisionModelConfig): Promise<void> => {
    await persist(
      models.map((item) =>
        item.id === model.id ? { ...item, enabled: !item.enabled } : item,
      ),
      model.enabled
        ? t("settings.decisionModelDisabledSuccess", {
            values: { name: model.name },
            defaultValue: `Disabled ${model.name}.`,
          })
        : t("settings.decisionModelEnabledSuccess", {
            values: { name: model.name },
            defaultValue: `Enabled ${model.name}.`,
          }),
    );
  };

  const confirmDelete = async (): Promise<void> => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) {
      return;
    }

    await persist(
      models.filter((item) => item.id !== target.id),
      t("settings.decisionModelDeleteSuccess", {
        values: { name: target.name },
        defaultValue: `Deleted ${target.name}.`,
      }),
    );
  };

  return (
    <>
      <div className="api-settings-manual-header">
        <strong>
          {t("settings.decisionModelsTitle", {
            defaultValue: "Decision models",
          })}
        </strong>
        <span>
          {t("settings.decisionModelsInfo", {
            defaultValue:
              "Decision models judge each result on its own instead of generating text. Configure them once here and select one wherever a decision model is needed (for example codebase agent review).",
          })}
        </span>
      </div>

      <div className="api-settings-table-panel">
        <div className="api-settings-table-toolbar">
          <button
            type="button"
            className="api-settings-action-btn primary"
            onClick={openNewDraft}
            disabled={isSaving}
          >
            <Plus size={15} />
            <span>
              {t("settings.decisionModelAdd", {
                defaultValue: "Add decision model",
              })}
            </span>
          </button>
        </div>

        <div className="api-settings-table-wrap">
          {isLoading && models.length === 0 ? (
            <div className="api-settings-empty">
              <Loader2 size={16} className="spin" />
              {t("settings.decisionModelsLoading", {
                defaultValue: "Loading...",
              })}
            </div>
          ) : models.length === 0 ? (
            <div className="api-settings-empty">
              {t("settings.decisionModelsEmpty", {
                defaultValue:
                  "No decision model configured yet. Add one to use it for codebase agent review.",
              })}
            </div>
          ) : (
            <table className="api-settings-table">
              <thead>
                <tr>
                  <th>{t("settings.tableName", { defaultValue: "Name" })}</th>
                  <th>{t("settings.tableModel", { defaultValue: "Model" })}</th>
                  <th>
                    {t("settings.tableBaseUrl", {
                      defaultValue: "Base URL",
                    })}
                  </th>
                  <th>
                    {t("settings.tableStatus", { defaultValue: "Status" })}
                  </th>
                  <th className="api-settings-table-actions-col">
                    {t("settings.tableActions", {
                      defaultValue: "Actions",
                    })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.id}>
                    <td className="cell-name">
                      <strong>{model.name}</strong>
                    </td>
                    <td>{model.model}</td>
                    <td className="cell-url">{model.baseUrl}</td>
                    <td>
                      <label
                        className="toggle-switch api-settings-table-switch"
                        title={t("settings.decisionModelToggle", {
                          defaultValue: "Enable or disable this decision model",
                        })}
                        aria-label={t("settings.decisionModelToggle", {
                          defaultValue: "Enable or disable this decision model",
                        })}
                      >
                        <input
                          type="checkbox"
                          checked={model.enabled}
                          onChange={() => void toggleEnabled(model)}
                          disabled={isSaving}
                        />
                        <span className="toggle-slider" aria-hidden="true" />
                        <span>
                          {model.enabled
                            ? t("settings.enabled", {
                                defaultValue: "Enabled",
                              })
                            : t("settings.disabled", {
                                defaultValue: "Disabled",
                              })}
                        </span>
                      </label>
                    </td>
                    <td className="api-settings-table-actions-col">
                      <div className="api-settings-table-actions">
                        <button
                          className="icon-btn ghost"
                          onClick={() => openEditDraft(model)}
                          disabled={isSaving}
                          type="button"
                          title={t("settings.edit", { defaultValue: "Edit" })}
                          aria-label={t("settings.edit", {
                            defaultValue: "Edit",
                          })}
                        >
                          <Pencil size={13} strokeWidth={1.8} />
                        </button>
                        <button
                          className="icon-btn ghost danger"
                          onClick={() => setPendingDelete(model)}
                          disabled={isSaving}
                          type="button"
                          title={t("settings.delete", {
                            defaultValue: "Delete",
                          })}
                          aria-label={t("settings.delete", {
                            defaultValue: "Delete",
                          })}
                        >
                          <Trash2 size={13} strokeWidth={1.8} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <Modal
        open={draft !== null}
        title={
          isNewDraft
            ? t("settings.decisionModelEditorAddTitle", {
                defaultValue: "Add decision model",
              })
            : t("settings.decisionModelEditorEditTitle", {
                defaultValue: "Edit decision model",
              })
        }
        description={t("settings.decisionModelEditorInfo", {
          defaultValue:
            "The API key is stored locally and never leaves your machine except when calling this endpoint.",
        })}
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={closeDraft}
        closeDisabled={isSaving}
        className="api-settings-editor-modal"
        footer={
          <>
            <button
              type="button"
              className="api-settings-form-btn secondary"
              onClick={closeDraft}
              disabled={isSaving}
            >
              <X size={15} strokeWidth={1.9} />
              <span>{t("settings.cancel", { defaultValue: "Cancel" })}</span>
            </button>
            <button
              type="button"
              className="api-settings-form-btn primary"
              onClick={() => void saveDraft()}
              disabled={isSaving}
            >
              {isSaving ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Save size={15} strokeWidth={1.9} />
              )}
              <span>
                {t("settings.decisionModelSave", {
                  defaultValue: "Save decision model",
                })}
              </span>
            </button>
          </>
        }
      >
        {draft && (
          <div className="api-settings-form-grid">
            <label className="api-settings-field">
              <span>
                {t("settings.decisionModelName", { defaultValue: "Name" })}
              </span>
              <input
                value={draft.name}
                onChange={(event) => updateDraft("name", event.target.value)}
                disabled={isSaving}
                placeholder={DEFAULT_DECISION_MODEL_NAME}
              />
            </label>
            <label className="api-settings-field">
              <span>
                {t("settings.decisionModelModel", {
                  defaultValue: "Model name",
                })}
              </span>
              <input
                value={draft.model}
                onChange={(event) => updateDraft("model", event.target.value)}
                disabled={isSaving}
                placeholder={DEFAULT_DECISION_MODEL_MODEL}
              />
            </label>
            <label className="api-settings-field wide">
              <span>
                {t("settings.decisionModelBaseUrl", {
                  defaultValue: "Base URL",
                })}
              </span>
              <input
                value={draft.baseUrl}
                onChange={(event) => updateDraft("baseUrl", event.target.value)}
                disabled={isSaving}
                placeholder={DEFAULT_DECISION_MODEL_BASE_URL}
              />
            </label>
            <label className="api-settings-field wide">
              <span>
                {t("settings.decisionModelApiKey", {
                  defaultValue: "API key",
                })}
              </span>
              <input
                type="password"
                value={draft.apiKey}
                onChange={(event) => updateDraft("apiKey", event.target.value)}
                disabled={isSaving}
              />
            </label>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        variant="danger"
        title={t("settings.decisionModelDeleteTitle", {
          defaultValue: "Delete decision model",
        })}
        message={t("settings.decisionModelDeleteConfirm", {
          values: { name: pendingDelete?.name ?? "" },
          defaultValue:
            "Delete {{name}}? Codebase agent review falls back to the LLM model if it was selected.",
        })}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        isConfirming={isSaving}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
