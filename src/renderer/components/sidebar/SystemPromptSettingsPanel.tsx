import { Download, Loader2, Plus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { Modal } from "../common/Modal";
import { useI18n } from "../../i18n";
import {
  SystemPromptEditor,
  SystemPromptEditorActions,
} from "./systemPrompt/SystemPromptEditor";
import { SystemPromptList } from "./systemPrompt/SystemPromptList";
import { SystemPromptSummary } from "./systemPrompt/SystemPromptSummary";
import { EMPTY_SYSTEM_PROMPT_DRAFT } from "./systemPrompt/systemPromptConstants";
import type {
  PromptDraft,
  SystemPromptItem,
  SystemPromptSettingsPanelProps,
} from "./systemPrompt/types";

export function SystemPromptSettingsPanel({
  onClose,
}: SystemPromptSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [prompts, setPrompts] = useState<SystemPromptItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const isBusy = isLoading || isSaving;

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const items = await window.snow.listSystemPrompts();
      setPrompts(items);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.systemPromptLoadError", {
              defaultValue: "Failed to load system prompts",
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
      const items = await window.snow.importSnowCliSystemPromptConfig();
      setPrompts(items);
      setStatus(
        t("settings.systemPromptImportSuccess", {
          defaultValue: "Synced system prompts from Snow CLI.",
        }),
      );
      setDraft(null);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.systemPromptImportError", {
              defaultValue: "Failed to sync Snow CLI system prompts",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const startAdd = () => {
    setDraft({ ...EMPTY_SYSTEM_PROMPT_DRAFT });
    setError("");
    setStatus("");
  };

  const startEdit = (prompt: SystemPromptItem) => {
    setDraft({
      promptId: prompt.promptId,
      name: prompt.name,
      content: prompt.content,
    });
    setError("");
    setStatus("");
  };

  const cancelDraft = () => {
    setDraft(null);
    setError("");
  };

  const saveDraft = async () => {
    if (!draft) return;

    const name = draft.name.trim();
    if (!name) {
      setError(
        t("settings.systemPromptNameRequired", {
          defaultValue: "Prompt name is required.",
        }),
      );
      setStatus("");
      return;
    }

    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      const isExisting = prompts.some(
        (prompt) => prompt.promptId === draft.promptId,
      );
      const maxSortOrder = prompts.reduce(
        (max, prompt) => Math.max(max, prompt.sortOrder),
        -1,
      );
      const existing = prompts.find(
        (prompt) => prompt.promptId === draft.promptId,
      );
      await window.snow.upsertSystemPrompt({
        promptId: draft.promptId || String(Date.now()),
        name,
        content: draft.content,
        isActive: isExisting
          ? (existing?.isActive ?? false)
          : prompts.length === 0,
        sortOrder: isExisting
          ? (existing?.sortOrder ?? maxSortOrder + 1)
          : maxSortOrder + 1,
        scope: existing?.scope ?? "global",
        ...(existing?.scope === "project" && existing.projectId
          ? { projectId: existing.projectId }
          : {}),
      });

      await load();
      setDraft(null);
      setStatus(
        isExisting
          ? t("settings.systemPromptSaveSuccess", {
              defaultValue: "Saved system prompt.",
            })
          : t("settings.systemPromptAddSuccess", {
              defaultValue: "Added system prompt.",
            }),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.systemPromptSaveError", {
              defaultValue: "Failed to save system prompt",
            }),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const toggleActive = async (prompt: SystemPromptItem) => {
    setError("");
    setStatus("");

    try {
      await window.snow.upsertSystemPrompt({
        promptId: prompt.promptId,
        name: prompt.name,
        content: prompt.content,
        isActive: !prompt.isActive,
        sortOrder: prompt.sortOrder,
        scope: prompt.scope,
        ...(prompt.scope === "project" && prompt.projectId
          ? { projectId: prompt.projectId }
          : {}),
      });
      await load();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.systemPromptSaveError", {
              defaultValue: "Failed to update system prompt",
            }),
      );
    }
  };

  const handleDelete = async (prompt: SystemPromptItem) => {
    setError("");
    setStatus("");

    try {
      await window.snow.deleteSystemPrompt(prompt.promptId);
      await load();
      setStatus(
        t("settings.systemPromptDeleteSuccess", {
          defaultValue: "Deleted system prompt.",
        }),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.systemPromptDeleteError", {
              defaultValue: "Failed to delete system prompt",
            }),
      );
    }
  };

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.systemPromptTitle", {
              defaultValue: "System prompt",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.systemPromptSettingsInfo", {
              defaultValue: "Customize the assistant system prompt.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeSystemPromptSettings", {
              defaultValue: "Close system prompt settings",
            })}
            title={t("settings.closeSystemPromptSettings", {
              defaultValue: "Close system prompt settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <SystemPromptSummary prompts={prompts} />

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
            {t("settings.syncSnowCliSystemPrompt", {
              defaultValue: "Sync Snow CLI system prompt config",
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
            {t("settings.systemPromptAddNew", {
              defaultValue: "Add prompt",
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
            {t("settings.systemPromptManualTitle", {
              defaultValue: "Manage prompts",
            })}
          </strong>
          <span>
            {t("settings.systemPromptManualInfo", {
              defaultValue:
                "These prompts are saved in the local app database and can be synced from ~/.snow/system-prompt.json.",
            })}
          </span>
        </div>

        <div className="api-settings-form-body">
          <SystemPromptList
            prompts={prompts}
            isBusy={isBusy}
            onToggleActive={(prompt) => void toggleActive(prompt)}
            onEdit={startEdit}
            onDelete={(prompt) => void handleDelete(prompt)}
          />
        </div>
      </div>

      <Modal
        open={Boolean(draft)}
        title={t("settings.systemPromptEditorTitle", {
          defaultValue: "Prompt editor",
        })}
        description={
          draft?.name ||
          t("settings.systemPromptAddNew", { defaultValue: "Add prompt" })
        }
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={cancelDraft}
        closeDisabled={isBusy}
        size="large"
        className="system-prompt-editor-modal"
        footer={
          draft && (
            <SystemPromptEditorActions
              isBusy={isBusy}
              isSaving={isSaving}
              onCancel={cancelDraft}
              onSave={() => void saveDraft()}
            />
          )
        }
      >
        {draft && (
          <SystemPromptEditor
            draft={draft}
            isBusy={isBusy}
            isSaving={isSaving}
            onNameChange={(name) =>
              setDraft((previous) => (previous ? { ...previous, name } : null))
            }
            onContentChange={(content) =>
              setDraft((previous) =>
                previous ? { ...previous, content } : null,
              )
            }
            onCancel={cancelDraft}
            onSave={() => void saveDraft()}
          />
        )}
      </Modal>
    </div>
  );
}
