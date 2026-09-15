import { FolderSearch, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../../../i18n";
import type {
  WorkspaceDirectoryRecord,
  WorkspaceDirectoryVerifyReport,
  WorkspaceRelinkReport,
} from "../../../../preload";
import { FormDialog } from "../../common/FormDialog";

type RelinkDirectoryDialogProps = {
  /** 待重新定位的项目记录；为 null 时对话框关闭。 */
  directory: WorkspaceDirectoryRecord | null;
  onCancel: () => void;
  onRelinked: (report: WorkspaceRelinkReport) => void;
};

const formatCounts = (
  report: WorkspaceRelinkReport,
  template: (values: Record<string, number>) => string,
): string =>
  template({
    conversations: report.conversations,
    memories: report.memories,
    memos: report.memos,
    tasks: report.scheduledTasks,
    collections: report.collectionsTouched,
  });

export function RelinkDirectoryDialog({
  directory,
  onCancel,
  onRelinked,
}: RelinkDirectoryDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [verifyReport, setVerifyReport] =
    useState<WorkspaceDirectoryVerifyReport | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [preview, setPreview] = useState<WorkspaceRelinkReport | null>(null);
  const [isLoadingReport, setIsLoadingReport] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSelectingFolder, setIsSelectingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const directoryId = directory?.directoryId ?? "";

  useEffect(() => {
    if (!directoryId) {
      setVerifyReport(null);
      setSelectedPath("");
      setPreview(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoadingReport(true);
    setError(null);

    void window.snow
      .verifyWorkspaceDirectory(directoryId)
      .then((report) => {
        if (cancelled) return;
        setVerifyReport(report);
      })
      .catch((verificationError: unknown) => {
        if (cancelled) return;
        setError(
          verificationError instanceof Error
            ? verificationError.message
            : String(verificationError),
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoadingReport(false);
      });

    return () => {
      cancelled = true;
    };
  }, [directoryId]);

  useEffect(() => {
    const targetPath = selectedPath.trim();
    if (!directoryId || !targetPath) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    setIsPreviewing(true);

    void window.snow
      .relinkWorkspaceDirectory(directoryId, targetPath, true)
      .then((result) => {
        if (cancelled) return;
        setPreview(result.report);
        setError(null);
      })
      .catch((previewError: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setError(
          previewError instanceof Error
            ? previewError.message
            : String(previewError),
        );
      })
      .finally(() => {
        if (!cancelled) setIsPreviewing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [directoryId, selectedPath]);

  const handleSelectFolder = useCallback(async (): Promise<void> => {
    if (isSelectingFolder || isSubmitting) return;
    setIsSelectingFolder(true);
    setError(null);
    try {
      const selected = await window.snow.selectWorkspaceDirectory(
        t("sidebar.relinkDirectorySelectTitle", {
          defaultValue: "Select the project's current location",
        }),
      );
      if (selected) {
        setSelectedPath(selected);
      }
    } catch (selectionError) {
      setError(
        selectionError instanceof Error
          ? selectionError.message
          : String(selectionError),
      );
    } finally {
      setIsSelectingFolder(false);
    }
  }, [isSelectingFolder, isSubmitting, t]);

  const handleConfirm = useCallback((): void => {
    const targetPath = selectedPath.trim();
    if (!directoryId || !targetPath || isSubmitting || isPreviewing) return;

    setIsSubmitting(true);
    setError(null);

    void (async (): Promise<void> => {
      try {
        const result = await window.snow.relinkWorkspaceDirectory(
          directoryId,
          targetPath,
          false,
        );
        onRelinked(result.report);
      } catch (relinkError) {
        setError(
          relinkError instanceof Error
            ? relinkError.message
            : String(relinkError),
        );
      } finally {
        setIsSubmitting(false);
      }
    })();
  }, [directoryId, isPreviewing, isSubmitting, onRelinked, selectedPath]);

  // 记录位置 = 数据库里登记的路径（这才是"失效"的那一个）；
  // 最近可用位置 = 上次确认存在过的路径，两者不同才额外提示，避免把正常位置说成"原位置"。
  const recordedPath = verifyReport?.path || directory?.path || "";
  const lastKnownPath =
    verifyReport?.lastKnownPath || directory?.lastKnownPath || "";
  const showLastKnownPath =
    lastKnownPath !== "" && lastKnownPath !== recordedPath;

  return (
    <FormDialog
      cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
      closeLabel={t("sidebar.close", { defaultValue: "Close" })}
      confirmDisabled={
        !selectedPath.trim() || isPreviewing || isLoadingReport || !preview
      }
      confirmLabel={t("sidebar.relinkDirectoryConfirm", {
        defaultValue: "Relink",
      })}
      isSubmitting={isSubmitting}
      onCancel={onCancel}
      onConfirm={handleConfirm}
      open={directory !== null}
      title={t("sidebar.relinkDirectoryTitle", {
        defaultValue: "Relink project location",
      })}
    >
      <p className="form-dialog-description">
        {t("sidebar.relinkDirectoryDescription", {
          defaultValue:
            "This project folder is no longer at its recorded location. Pick its current folder to move the project's history (conversations, memory, tasks and project settings) to the new location.",
        })}
      </p>
      <span className="form-dialog-description relink-directory-path">
        {t("sidebar.relinkDirectoryRecordedPath", {
          defaultValue: "Recorded location: {{path}}",
          values: { path: recordedPath },
        })}
      </span>
      {showLastKnownPath ? (
        <span className="form-dialog-description relink-directory-path">
          {t("sidebar.relinkDirectoryLastKnownPath", {
            defaultValue: "Last known location: {{path}}",
            values: { path: lastKnownPath },
          })}
        </span>
      ) : null}

      {isLoadingReport ? (
        <span className="form-dialog-description relink-directory-status">
          <Loader2 className="spin" size={12} />
          {t("sidebar.relinkDirectoryScanning", {
            defaultValue: "Checking the project's recorded location",
          })}
        </span>
      ) : null}

      <label className="form-dialog-field">
        <span className="form-dialog-label">
          {t("sidebar.relinkDirectoryTargetLabel", {
            defaultValue: "Current location",
          })}
        </span>
        <div className="form-dialog-input-row">
          <input
            className="form-dialog-input"
            placeholder={t("sidebar.localDirectoryPathPlaceholder", {
              defaultValue: "No folder selected",
            })}
            readOnly
            value={selectedPath}
          />
          <button
            className="form-dialog-button cancel form-dialog-browse-button"
            disabled={isSubmitting || isSelectingFolder}
            onClick={() => void handleSelectFolder()}
            type="button"
          >
            <FolderSearch size={13} />
            {t("sidebar.selectFolder", { defaultValue: "Select folder" })}
          </button>
        </div>
      </label>

      {preview ? (
        <span className="form-dialog-description relink-directory-preview">
          {formatCounts(preview, (values) =>
            t("sidebar.relinkDirectoryPreview", {
              defaultValue:
                "Will move {{conversations}} conversation(s), {{memories}} memory entries, {{memos}} memo(s) and {{tasks}} scheduled task(s) to the new location.",
              values,
            }),
          )}
          {preview.merged
            ? ` ${t("sidebar.relinkDirectoryMerged", {
                defaultValue:
                  "An existing record for this location will be merged.",
              })}`
            : ""}
          {preview.codebaseReindexRequired
            ? ` ${t("sidebar.relinkDirectoryReindex", {
                defaultValue:
                  "The codebase index will be cleared and can be rebuilt afterwards.",
              })}`
            : ""}
        </span>
      ) : null}

      {error ? <span className="form-dialog-error">{error}</span> : null}
    </FormDialog>
  );
}
