import { useRef } from "react";

import { useI18n } from "../../../../../i18n";
import { FormDialog } from "../../../../common/FormDialog";

type RenameCollectionDialogProps = {
  open: boolean;
  name: string;
  isSubmitting: boolean;
  error: string | null;
  onNameChange: (name: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function RenameCollectionDialog({
  open,
  name,
  isSubmitting,
  error,
  onNameChange,
  onCancel,
  onConfirm,
}: RenameCollectionDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <FormDialog
      cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
      closeLabel={t("sidebar.close", { defaultValue: "Close" })}
      confirmDisabled={!name.trim()}
      confirmLabel={t("sidebar.renameCollectionConfirm", {
        defaultValue: "Rename",
      })}
      initialFocusRef={inputRef}
      isSubmitting={isSubmitting}
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={open}
      title={t("sidebar.renameCollectionTitle", {
        defaultValue: "Rename collection",
      })}
    >
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
