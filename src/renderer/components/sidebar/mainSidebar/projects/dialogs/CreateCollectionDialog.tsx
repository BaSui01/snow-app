import { useRef } from "react";

import { useI18n } from "../../../../../i18n";
import { FormDialog } from "../../../../common/FormDialog";

type CreateCollectionDialogProps = {
  open: boolean;
  name: string;
  isSubmitting: boolean;
  error: string | null;
  onNameChange: (name: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function CreateCollectionDialog({
  open,
  name,
  isSubmitting,
  error,
  onNameChange,
  onCancel,
  onConfirm,
}: CreateCollectionDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <FormDialog
      cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
      closeLabel={t("sidebar.close", { defaultValue: "Close" })}
      confirmDisabled={!name.trim()}
      confirmLabel={t("sidebar.createCollectionConfirm", {
        defaultValue: "Create",
      })}
      initialFocusRef={inputRef}
      isSubmitting={isSubmitting}
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={open}
      title={t("sidebar.createCollectionTitle", {
        defaultValue: "Create a new collection",
      })}
    >
      <p className="form-dialog-description">
        {t("sidebar.createCollectionDialogDescription", {
          defaultValue:
            "A collection organizes projects into a group. Drag a project onto the collection to add it — it then appears only inside the collection, not in the list above it. The project itself is untouched.",
        })}
      </p>
      <label className="form-dialog-field">
        <span className="form-dialog-label">
          {t("sidebar.createCollectionNameLabel", {
            defaultValue: "Collection name",
          })}
        </span>
        <input
          ref={inputRef}
          className="form-dialog-input"
          disabled={isSubmitting}
          maxLength={60}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onConfirm();
            }
          }}
          placeholder={t("sidebar.createCollectionNamePlaceholder", {
            defaultValue: "Collection name",
          })}
          value={name}
        />
      </label>
      {error ? <span className="form-dialog-error">{error}</span> : null}
    </FormDialog>
  );
}
