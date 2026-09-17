import { useRef } from "react";

import { useI18n } from "../../../../../i18n";
import { FormDialog } from "../../../../common/FormDialog";

type CreateProjectDialogProps = {
  open: boolean;
  name: string;
  isSubmitting: boolean;
  error: string | null;
  onNameChange: (name: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function CreateProjectDialog({
  open,
  name,
  isSubmitting,
  error,
  onNameChange,
  onCancel,
  onConfirm,
}: CreateProjectDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <FormDialog
      cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
      closeLabel={t("sidebar.close", { defaultValue: "Close" })}
      confirmDisabled={!name.trim()}
      confirmLabel={t("sidebar.createProjectConfirm", {
        defaultValue: "Create",
      })}
      initialFocusRef={inputRef}
      isSubmitting={isSubmitting}
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={open}
      title={t("sidebar.createProjectTitle", {
        defaultValue: "Create a new project",
      })}
    >
      <label className="form-dialog-field">
        <span className="form-dialog-label">
          {t("sidebar.createProjectNameLabel", {
            defaultValue: "Project name",
          })}
        </span>
        <input
          ref={inputRef}
          className="form-dialog-input"
          disabled={isSubmitting}
          maxLength={120}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onConfirm();
            }
          }}
          placeholder={t("sidebar.createProjectNamePlaceholder", {
            defaultValue: "Project name",
          })}
          value={name}
        />
      </label>
      {error ? <span className="form-dialog-error">{error}</span> : null}
    </FormDialog>
  );
}
