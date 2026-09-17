import { FolderPlus } from "lucide-react";
import { useRef } from "react";

import { useI18n } from "../../../../../i18n";
import { FormDialog } from "../../../../common/FormDialog";

type AddLocalDirectoryDialogProps = {
  open: boolean;
  path: string;
  isDragging: boolean;
  isSubmitting: boolean;
  error: string | null;
  onDragStateChange: (isDragging: boolean) => void;
  onDropFiles: (files: File[]) => void;
  onSelectFolder: () => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function AddLocalDirectoryDialog({
  open,
  path,
  isDragging,
  isSubmitting,
  error,
  onDragStateChange,
  onDropFiles,
  onSelectFolder,
  onCancel,
  onConfirm,
}: AddLocalDirectoryDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <FormDialog
      cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
      closeLabel={t("sidebar.close", { defaultValue: "Close" })}
      confirmDisabled={!path.trim()}
      confirmLabel={t("sidebar.add", { defaultValue: "Add" })}
      initialFocusRef={inputRef}
      isSubmitting={isSubmitting}
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={open}
      title={t("sidebar.addLocalDirectory", {
        defaultValue: "Add local directory",
      })}
    >
      <p className="form-dialog-description">
        {t("sidebar.addLocalDirectoryDescription", {
          defaultValue:
            "Select a local folder to add as a workspace directory.",
        })}
      </p>
      <div
        className={`form-dialog-drop-zone${isDragging ? " drag-over" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          onDragStateChange(true);
        }}
        onDragLeave={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            onDragStateChange(false);
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          onDragStateChange(false);
          onDropFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <FolderPlus size={22} />
        <strong>
          {t("sidebar.localDirectoryDropTitle", {
            defaultValue: "Drop a folder here",
          })}
        </strong>
        <span>
          {t("sidebar.localDirectoryDropHint", {
            defaultValue: "Or use Select folder below",
          })}
        </span>
      </div>
      <label className="form-dialog-field">
        <span className="form-dialog-label">
          {t("sidebar.localDirectoryPathLabel", {
            defaultValue: "Folder path",
          })}
        </span>
        <div className="form-dialog-input-row">
          <input
            ref={inputRef}
            className="form-dialog-input"
            placeholder={t("sidebar.localDirectoryPathPlaceholder", {
              defaultValue: "No folder selected",
            })}
            readOnly
            value={path}
          />
          <button
            className="form-dialog-button cancel form-dialog-browse-button"
            disabled={isSubmitting}
            onClick={onSelectFolder}
            type="button"
          >
            {t("sidebar.selectFolder", { defaultValue: "Select folder" })}
          </button>
        </div>
      </label>
      {error ? <span className="form-dialog-error">{error}</span> : null}
    </FormDialog>
  );
}
