import { useRef } from "react";

import { useI18n } from "../../../../../i18n";
import type { WorkspaceDirectoryRecord } from "../../../../../../preload";
import { FormDialog } from "../../../../common/FormDialog";

type LinkProjectsDialogProps = {
  open: boolean;
  /** 触发关联的目录：固定参与关联，不作为可选项展示 */
  sourceDirectory: WorkspaceDirectoryRecord | null;
  /** 可关联的其它目录 */
  directories: WorkspaceDirectoryRecord[];
  selectedDirectoryIds: Set<string>;
  name: string;
  isSubmitting: boolean;
  error: string | null;
  onNameChange: (name: string) => void;
  onToggleDirectory: (directoryId: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function LinkProjectsDialog({
  open,
  sourceDirectory,
  directories,
  selectedDirectoryIds,
  name,
  isSubmitting,
  error,
  onNameChange,
  onToggleDirectory,
  onCancel,
  onConfirm,
}: LinkProjectsDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const confirmDisabled = !name.trim() || selectedDirectoryIds.size === 0;

  return (
    <FormDialog
      cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
      closeLabel={t("sidebar.close", { defaultValue: "Close" })}
      confirmDisabled={confirmDisabled}
      confirmLabel={t("sidebar.linkProjectsConfirm", {
        defaultValue: "Link",
      })}
      initialFocusRef={inputRef}
      isSubmitting={isSubmitting}
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={open}
      title={t("sidebar.linkProjectsTitle", {
        defaultValue: "Link projects",
      })}
    >
      <p className="form-dialog-description">
        {t("sidebar.linkProjectsDialogDescription", {
          defaultValue:
            "Linked projects are treated as one unified project: file search, grep and the system prompt all cover every linked directory. The directories themselves are not modified.",
        })}
      </p>
      <label className="form-dialog-field">
        <span className="form-dialog-label">
          {t("sidebar.linkProjectsNameLabel", {
            defaultValue: "Group name",
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
          placeholder={t("sidebar.linkProjectsNamePlaceholder", {
            defaultValue: "Group name",
          })}
          value={name}
        />
      </label>
      <div className="form-dialog-field">
        <span className="form-dialog-label">
          {sourceDirectory
            ? t("sidebar.linkProjectsSelectLabel", {
                values: { name: sourceDirectory.name },
                defaultValue: "Select the projects to link with {{name}}",
              })
            : t("sidebar.linkProjectsSelectLabelEmpty", {
                defaultValue: "Select the projects to link",
              })}
        </span>
        {directories.length === 0 ? (
          <span className="link-projects-empty">
            {t("sidebar.linkProjectsEmpty", {
              defaultValue:
                "No other projects available — add another directory first.",
            })}
          </span>
        ) : (
          <div className="link-projects-list">
            {directories.map((directory) => (
              <label className="link-projects-item" key={directory.directoryId}>
                <input
                  checked={selectedDirectoryIds.has(directory.directoryId)}
                  disabled={isSubmitting}
                  onChange={() => onToggleDirectory(directory.directoryId)}
                  type="checkbox"
                />
                <span className="link-projects-item-text">
                  <span className="link-projects-item-name">
                    {directory.name}
                  </span>
                  <span
                    className="link-projects-item-path"
                    title={directory.path}
                  >
                    {directory.path}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
      {error ? <span className="form-dialog-error">{error}</span> : null}
    </FormDialog>
  );
}
