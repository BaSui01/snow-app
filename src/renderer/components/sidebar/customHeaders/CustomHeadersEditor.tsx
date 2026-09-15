import { Loader2, Plus, Save, Trash2, X } from "lucide-react";
import { useI18n } from "../../../i18n";
import type { SchemeDraft } from "./types";

type CustomHeadersEditorProps = {
  draft: SchemeDraft;
  isBusy: boolean;
  isSaving: boolean;
  onNameChange: (name: string) => void;
  onUpdateHeaderPair: (
    pairId: string,
    field: "key" | "value",
    value: string,
  ) => void;
  onAddHeaderPair: () => void;
  onRemoveHeaderPair: (pairId: string) => void;
  onCancel: () => void;
  onSave: () => void;
};

export function CustomHeadersEditor({
  draft,
  isBusy,
  isSaving,
  onNameChange,
  onUpdateHeaderPair,
  onAddHeaderPair,
  onRemoveHeaderPair,
  onCancel,
  onSave,
}: CustomHeadersEditorProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <>
      <div className="api-settings-form-grid">
        <label className="api-settings-field wide">
          <span>
            {t("settings.customHeadersSchemeName", {
              defaultValue: "Scheme name",
            })}
          </span>
          <input
            value={draft.name}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder={t("settings.customHeadersNamePlaceholder", {
              defaultValue: "e.g. OpenAI headers",
            })}
            disabled={isBusy}
          />
        </label>
      </div>

      <div className="custom-headers-editor-list">
        {draft.headers.map((pair) => (
          <div className="custom-headers-editor-row" key={pair.id}>
            <label className="api-settings-field">
              <span>
                {t("settings.customHeadersHeaderName", {
                  defaultValue: "Header name",
                })}
              </span>
              <input
                value={pair.key}
                onChange={(event) =>
                  onUpdateHeaderPair(pair.id, "key", event.target.value)
                }
                placeholder={t("settings.customHeadersHeaderNamePlaceholder", {
                  defaultValue: "e.g. X-Request-ID",
                })}
                disabled={isBusy}
              />
            </label>
            <label className="api-settings-field">
              <span>
                {t("settings.customHeadersHeaderValue", {
                  defaultValue: "Header value",
                })}
              </span>
              <input
                value={pair.value}
                onChange={(event) =>
                  onUpdateHeaderPair(pair.id, "value", event.target.value)
                }
                placeholder={t("settings.customHeadersHeaderValuePlaceholder", {
                  defaultValue: "Header value",
                })}
                disabled={isBusy}
              />
            </label>
            <button
              className="icon-btn ghost danger custom-headers-remove-btn"
              onClick={() => onRemoveHeaderPair(pair.id)}
              type="button"
              aria-label={t("settings.customHeadersRemoveHeader", {
                defaultValue: "Remove header",
              })}
              title={t("settings.customHeadersRemoveHeader", {
                defaultValue: "Remove header",
              })}
              disabled={isBusy}
            >
              <Trash2 size={14} strokeWidth={1.9} />
            </button>
          </div>
        ))}
      </div>

      <small className="api-settings-hint-text">
        {t("settings.customHeadersVariablesHint", {
          defaultValue:
            "Use {{session_id}} in a value: it is replaced with the session ID of the conversation that sends the request ({{sessionId}} works too). Requests without a session context omit this header.",
        })}
      </small>
    </>
  );
}

type CustomHeadersEditorActionsProps = {
  isBusy: boolean;
  isSaving: boolean;
  onAddHeaderPair: () => void;
  onCancel: () => void;
  onSave: () => void;
};

export function CustomHeadersEditorActions({
  isBusy,
  isSaving,
  onAddHeaderPair,
  onCancel,
  onSave,
}: CustomHeadersEditorActionsProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <>
      <button
        className="api-settings-form-btn secondary"
        onClick={onAddHeaderPair}
        type="button"
        disabled={isBusy}
      >
        <Plus size={15} />
        <span>
          {t("settings.customHeadersAddHeader", {
            defaultValue: "Add header",
          })}
        </span>
      </button>
      <button
        className="api-settings-form-btn secondary"
        onClick={onCancel}
        type="button"
        disabled={isBusy}
      >
        <X size={15} strokeWidth={1.9} />
        <span>{t("settings.cancel", { defaultValue: "Cancel" })}</span>
      </button>
      <button
        className="api-settings-form-btn primary"
        onClick={onSave}
        type="button"
        disabled={isBusy}
      >
        {isSaving ? (
          <Loader2 size={15} className="spin" />
        ) : (
          <Save size={15} strokeWidth={1.9} />
        )}
        <span>
          {t("settings.saveCustomHeaders", {
            defaultValue: "Save scheme",
          })}
        </span>
      </button>
    </>
  );
}
