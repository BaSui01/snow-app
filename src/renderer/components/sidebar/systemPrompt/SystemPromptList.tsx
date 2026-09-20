import { Pencil, Trash2 } from "lucide-react";
import { useI18n } from "../../../i18n";
import type { SystemPromptItem } from "./types";

type SystemPromptListProps = {
  prompts: SystemPromptItem[];
  isBusy: boolean;
  onToggleActive: (prompt: SystemPromptItem) => void;
  onEdit: (prompt: SystemPromptItem) => void;
  onDelete: (prompt: SystemPromptItem) => void;
};

export function SystemPromptList({
  prompts,
  isBusy,
  onToggleActive,
  onEdit,
  onDelete,
}: SystemPromptListProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">
          {t("settings.systemPromptListTitle", {
            defaultValue: "Prompt list",
          })}
        </strong>
      </div>

      <div className="system-prompt-list">
        {prompts.length === 0 ? (
          <div className="system-prompt-empty">
            {t("settings.systemPromptNoPrompts", {
              defaultValue:
                "No prompts yet. Import from Snow CLI or add one manually.",
            })}
          </div>
        ) : (
          prompts.map((prompt) => {
            const activeLabel = prompt.isActive
              ? t("settings.systemPromptDeactivate", {
                  defaultValue: "Deactivate",
                })
              : t("settings.systemPromptActivate", {
                  defaultValue: "Activate",
                });
            const activeStateLabel = prompt.isActive
              ? t("settings.active", { defaultValue: "Active" })
              : t("settings.inactive", { defaultValue: "Inactive" });

            return (
              <div
                key={prompt.promptId}
                className={`system-prompt-item ${
                  prompt.isActive ? "active" : ""
                }`}
              >
                <div className="system-prompt-item-main">
                  <label
                    className="toggle-switch system-prompt-switch"
                    aria-label={activeLabel}
                    title={activeLabel}
                  >
                    <input
                      type="checkbox"
                      checked={prompt.isActive}
                      onChange={() => onToggleActive(prompt)}
                      disabled={isBusy}
                      hidden
                    />
                    <span className="toggle-slider" />
                    <span>{activeStateLabel}</span>
                  </label>
                  <div className="system-prompt-item-info">
                    <strong>{prompt.name}</strong>
                    <span>
                      {prompt.content
                        ? prompt.content.substring(0, 120) +
                          (prompt.content.length > 120 ? "..." : "")
                        : t("settings.systemPromptNoContent", {
                            defaultValue: "No content",
                          })}
                    </span>
                  </div>
                </div>
                <div className="system-prompt-item-actions">
                  <button
                    className="icon-btn ghost"
                    onClick={() => onEdit(prompt)}
                    type="button"
                    aria-label={t("settings.edit", { defaultValue: "Edit" })}
                    title={t("settings.edit", { defaultValue: "Edit" })}
                    disabled={isBusy}
                  >
                    <Pencil size={14} strokeWidth={1.9} />
                  </button>
                  <button
                    className="icon-btn ghost danger"
                    onClick={() => onDelete(prompt)}
                    type="button"
                    aria-label={t("settings.delete", {
                      defaultValue: "Delete",
                    })}
                    title={t("settings.delete", { defaultValue: "Delete" })}
                    disabled={isBusy}
                  >
                    <Trash2 size={14} strokeWidth={1.9} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
