import { Loader2 } from "lucide-react";
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
  isAborting: boolean;
  error: string | null;
  onRepoUrlChange: (repoUrl: string) => void;
  onSelectFolder: () => void;
  /**
   * 关闭弹窗：空闲时=取消；克隆中=让克隆在后台继续（不中断 git 进程，
   * 进度移到侧边栏项目区的占位条目上）。
   */
  onCancel: () => void;
  onConfirm: () => void;
  /** 克隆中：中止克隆（Rust 侧杀进程树 + 清理半成品目录）。 */
  onAbort: () => void;
};

export function CloneRepositoryDialog({
  open,
  repoUrl,
  parentPath,
  targetPreview,
  progress,
  isSubmitting,
  isAborting,
  error,
  onRepoUrlChange,
  onSelectFolder,
  onCancel,
  onConfirm,
  onAbort,
}: CloneRepositoryDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const percent = progress?.percent ?? null;
  const percentWidth =
    percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const progressMessage = progress
    ? percent !== null
      ? `${percent.toFixed(0)}% · ${progress.line}`
      : progress.line
    : t("sidebar.cloneStarting", { defaultValue: "Starting git clone…" });

  // 克隆进行中的底部操作区：「中止克隆」中断任务，「在后台继续」只是
  // 关闭弹窗（克隆照常跑完并自动登记为项目）。
  const cloningFooter = (
    <>
      <button
        className="form-dialog-button abort"
        disabled={isAborting}
        onClick={onAbort}
        type="button"
      >
        {isAborting ? <span className="form-dialog-spinner" /> : null}
        {t("sidebar.cloneAbort", { defaultValue: "Abort clone" })}
      </button>
      <button
        className="form-dialog-button confirm"
        onClick={onCancel}
        type="button"
      >
        {t("sidebar.cloneRunInBackground", {
          defaultValue: "Run in background",
        })}
      </button>
    </>
  );

  return (
    <FormDialog
      cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
      closeLabel={
        isSubmitting
          ? t("sidebar.cloneKeepCloningHint", {
              defaultValue: "Close and keep cloning in the background",
            })
          : t("sidebar.close", { defaultValue: "Close" })
      }
      confirmDisabled={!repoUrl.trim() || !parentPath.trim()}
      confirmLabel={t("sidebar.cloneRepositoryConfirm", {
        defaultValue: "Clone",
      })}
      dismissableWhenSubmitting
      footer={isSubmitting ? cloningFooter : undefined}
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
      {isSubmitting ? (
        <div className="clone-progress">
          {percent !== null ? (
            <div className="clone-progress-track">
              <div
                className="clone-progress-fill"
                style={{ width: `${percentWidth}%` }}
              />
            </div>
          ) : null}
          <span className="clone-progress-status">
            <Loader2 className="spin" size={12} strokeWidth={1.9} />
            <span className="clone-progress-message">{progressMessage}</span>
          </span>
          <span className="form-dialog-description">
            {t("sidebar.cloneBackgroundHint", {
              defaultValue:
                "Closing this dialog keeps the clone running in the background — progress and abort stay available in the project list.",
            })}
          </span>
        </div>
      ) : null}
      {error ? <span className="form-dialog-error">{error}</span> : null}
    </FormDialog>
  );
}
