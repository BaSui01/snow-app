import { useRef } from "react";

import { useI18n } from "../../../../../i18n";
import { FormDialog } from "../../../../common/FormDialog";
import type { GitCloneProgress } from "../../../../../../preload";

type CloneRepositoryDialogProps = {
  open: boolean;
  repoUrl: string;
  parentPath: string;
  targetPreview: string;
  progress: GitCloneProgress | null;
  isSubmitting: boolean;
  error: string | null;
  onRepoUrlChange: (repoUrl: string) => void;
  onSelectFolder: () => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function CloneRepositoryDialog({
  open,
  repoUrl,
  parentPath,
  targetPreview,
  progress,
  isSubmitting,
  error,
  onRepoUrlChange,
  onSelectFolder,
  onCancel,
  onConfirm,
}: CloneRepositoryDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <FormDialog
      cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
      closeLabel={t("sidebar.close", { defaultValue: "Close" })}
      confirmDisabled={!repoUrl.trim() || !parentPath.trim()}
      confirmLabel={t("sidebar.cloneRepositoryConfirm", {
        defaultValue: "Clone",
      })}
      initialFocusRef={inputRef}
      isSubmitting={isSubmitting}
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={open}
      title={t("sidebar.cloneRepositoryTitle", {
        defaultValue: "Clone git repository",
      })}
    >
      <p className="form-dialog-description">
        {t("sidebar.cloneRepositoryDialogDescription", {
          defaultValue:
            "Enter the repository URL and choose a save location. A new folder named after the repository will be created automatically.",
        })}
      </p>
      <label className="form-dialog-field">
        <span className="form-dialog-label">
          {t("sidebar.cloneRepositoryUrlLabel", {
            defaultValue: "Repository URL",
          })}
        </span>
        <input
          ref={inputRef}
          className="form-dialog-input"
          disabled={isSubmitting}
          maxLength={400}
          onChange={(event) => onRepoUrlChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onConfirm();
            }
          }}
          placeholder={t("sidebar.cloneRepositoryUrlPlaceholder", {
            defaultValue: "https://github.com/user/repo.git",
          })}
          value={repoUrl}
        />
      </label>
      <label className="form-dialog-field">
        <span className="form-dialog-label">
          {t("sidebar.cloneSaveLocationLabel", {
            defaultValue: "Save location",
          })}
        </span>
        <div className="form-dialog-input-row">
          <input
            className="form-dialog-input"
            placeholder={t("sidebar.cloneDirectoryPlaceholder", {
              defaultValue: "No folder selected",
            })}
            readOnly
            value={parentPath}
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
      {targetPreview ? (
        <span className="form-dialog-description clone-progress-text">
          {t("sidebar.cloneTargetPreview", {
            defaultValue: "Will clone to",
            values: { path: targetPreview },
          })}
        </span>
      ) : null}
      {progress ? (
        <span className="form-dialog-description clone-progress-text">
          {progress.percent !== null && progress.percent !== undefined
            ? `${progress.percent.toFixed(0)}% · ${progress.line}`
            : progress.line}
        </span>
      ) : null}
      {error ? <span className="form-dialog-error">{error}</span> : null}
    </FormDialog>
  );
}
