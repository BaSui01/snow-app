import { Download, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { Modal } from "../common/Modal";
import {
  CustomHeadersEditor,
  CustomHeadersEditorActions,
} from "./customHeaders/CustomHeadersEditor";
import { CustomHeadersSchemeList } from "./customHeaders/CustomHeadersSchemeList";
import { CustomHeadersSummary } from "./customHeaders/CustomHeadersSummary";
import {
  EMPTY_CUSTOM_HEADERS_DRAFT,
  createHeaderPair,
  hasDuplicateHeaderKey,
  toHeaderPairs,
  toHeadersJson,
} from "./customHeaders/customHeadersUtils";
import type { CustomHeaderScheme, SchemeDraft } from "./customHeaders/types";

export function CustomHeadersSettingsPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [schemes, setSchemes] = useState<CustomHeaderScheme[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [draft, setDraft] = useState<SchemeDraft | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const isBusy = isLoading || isSaving;

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const items = await window.snow.listCustomHeaderSchemes();
      setSchemes(items);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.customHeadersLoadError", {
              defaultValue: "Failed to load custom headers",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleImport = async () => {
    setIsLoading(true);
    setError("");
    setStatus("");

    try {
      const items = await window.snow.importSnowCliCustomHeadersConfig();
      setSchemes(items);
      setDraft(null);
      setStatus(
        t("settings.customHeadersImportSuccess", {
          defaultValue: "Synced custom headers from Snow CLI.",
        }),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.customHeadersImportError", {
              defaultValue: "Failed to sync Snow CLI custom headers",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const startAdd = () => {
    setDraft({
      ...EMPTY_CUSTOM_HEADERS_DRAFT,
      headers: [createHeaderPair()],
    });
    setError("");
    setStatus("");
  };

  const startEdit = (scheme: CustomHeaderScheme) => {
    const headers = toHeaderPairs(scheme.headersJson);
    setDraft({
      schemeId: scheme.schemeId,
      name: scheme.name,
      headers: headers.length > 0 ? headers : [createHeaderPair()],
    });
    setError("");
    setStatus("");
  };

  const cancelDraft = () => {
    setDraft(null);
    setError("");
  };

  const updateHeaderPair = (
    pairId: string,
    field: "key" | "value",
    value: string,
  ) => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            headers: previous.headers.map((pair) =>
              pair.id === pairId ? { ...pair, [field]: value } : pair,
            ),
          }
        : null,
    );
  };

  const addHeaderPair = () => {
    setDraft((previous) =>
      previous
        ? { ...previous, headers: [...previous.headers, createHeaderPair()] }
        : null,
    );
  };

  const removeHeaderPair = (pairId: string) => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            headers:
              previous.headers.length > 1
                ? previous.headers.filter((pair) => pair.id !== pairId)
                : [createHeaderPair()],
          }
        : null,
    );
  };

  const saveDraft = async () => {
    if (!draft) return;

    const name = draft.name.trim();
    if (!name) {
      setError(
        t("settings.customHeadersNameRequired", {
          defaultValue: "Scheme name is required.",
        }),
      );
      setStatus("");
      return;
    }

    if (hasDuplicateHeaderKey(draft.headers)) {
      setError(
        t("settings.customHeadersDuplicateKey", {
          defaultValue: "Header names must be unique.",
        }),
      );
      setStatus("");
      return;
    }

    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      const isExisting = schemes.some(
        (scheme) => scheme.schemeId === draft.schemeId,
      );
      const existing = schemes.find(
        (scheme) => scheme.schemeId === draft.schemeId,
      );
      const maxSortOrder = schemes.reduce(
        (max, scheme) => Math.max(max, scheme.sortOrder),
        -1,
      );

      const items = await window.snow.upsertCustomHeaderScheme({
        schemeId: draft.schemeId || String(Date.now()),
        name,
        headersJson: toHeadersJson(draft.headers),
        isActive: isExisting
          ? (existing?.isActive ?? false)
          : schemes.length === 0,
        sortOrder: isExisting
          ? (existing?.sortOrder ?? maxSortOrder + 1)
          : maxSortOrder + 1,
      });

      setSchemes(items);
      setDraft(null);
      setStatus(
        isExisting
          ? t("settings.customHeadersSaveSuccess", {
              defaultValue: "Saved custom header scheme.",
            })
          : t("settings.customHeadersAddSuccess", {
              defaultValue: "Added custom header scheme.",
            }),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.customHeadersSaveError", {
              defaultValue: "Failed to save custom headers",
            }),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const toggleActive = async (scheme: CustomHeaderScheme) => {
    setError("");
    setStatus("");

    try {
      const items = await window.snow.upsertCustomHeaderScheme({
        schemeId: scheme.schemeId,
        name: scheme.name,
        headersJson: scheme.headersJson,
        isActive: !scheme.isActive,
        sortOrder: scheme.sortOrder,
      });
      setSchemes(items);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.customHeadersSaveError", {
              defaultValue: "Failed to update custom headers",
            }),
      );
    }
  };

  const handleDelete = async (scheme: CustomHeaderScheme) => {
    setError("");
    setStatus("");

    try {
      const items = await window.snow.deleteCustomHeaderScheme(scheme.schemeId);
      setSchemes(items);
      setStatus(
        t("settings.customHeadersDeleteSuccess", {
          defaultValue: "Deleted custom header scheme.",
        }),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.customHeadersDeleteError", {
              defaultValue: "Failed to delete custom headers",
            }),
      );
    }
  };

  return (
    <div className="api-settings-page" role="region">
      <CustomHeadersSummary schemes={schemes} />

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
            {t("settings.syncSnowCliCustomHeaders", {
              defaultValue: "Sync Snow CLI custom headers config",
            })}
          </span>
        </button>
        <button
          className="api-settings-action-btn secondary"
          onClick={startAdd}
          type="button"
          disabled={isBusy}
        >
          <Plus size={15} />
          <span>
            {t("settings.customHeadersAddNew", {
              defaultValue: "Add scheme",
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

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>
            {t("settings.customHeadersManualTitle", {
              defaultValue: "Manage request header schemes",
            })}
          </strong>
          <span>
            {t("settings.customHeadersManualInfo", {
              defaultValue:
                "These schemes are saved in the local app database and can be synced from ~/.snow/custom-headers.json.",
            })}
          </span>
        </div>

        <div className="api-settings-form-body">
          <CustomHeadersSchemeList
            schemes={schemes}
            isBusy={isBusy}
            onToggleActive={(scheme) => void toggleActive(scheme)}
            onEdit={startEdit}
            onDelete={(scheme) => void handleDelete(scheme)}
          />
        </div>
      </div>

      <Modal
        open={Boolean(draft)}
        title={t("settings.customHeadersEditorTitle", {
          defaultValue: "Scheme editor",
        })}
        description={
          draft?.name ||
          t("settings.customHeadersAddNew", { defaultValue: "Add scheme" })
        }
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={cancelDraft}
        closeDisabled={isBusy}
        size="large"
        className="custom-headers-editor-modal"
        footer={
          draft && (
            <CustomHeadersEditorActions
              isBusy={isBusy}
              isSaving={isSaving}
              onAddHeaderPair={addHeaderPair}
              onCancel={cancelDraft}
              onSave={() => void saveDraft()}
            />
          )
        }
      >
        {draft && (
          <CustomHeadersEditor
            draft={draft}
            isBusy={isBusy}
            isSaving={isSaving}
            onNameChange={(name) =>
              setDraft((previous) => (previous ? { ...previous, name } : null))
            }
            onUpdateHeaderPair={updateHeaderPair}
            onAddHeaderPair={addHeaderPair}
            onRemoveHeaderPair={removeHeaderPair}
            onCancel={cancelDraft}
            onSave={() => void saveDraft()}
          />
        )}
      </Modal>
    </div>
  );
}
