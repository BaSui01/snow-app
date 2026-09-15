import { ArrowRight, History, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../../../i18n";
import type {
  WorkspaceDirectoryRecord,
  WorkspaceRelinkRecord,
} from "../../../../preload";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { FormDialog } from "../../common/FormDialog";

type RelinkHistoryDialogProps = {
  /** 查看迁移记录的项目；为 null 时对话框关闭。 */
  directory: WorkspaceDirectoryRecord | null;
  onCancel: () => void;
  /** 撤销成功后通知上层刷新项目列表（目录 id 会回退）。 */
  onUndone: () => void;
};

export function RelinkHistoryDialog({
  directory,
  onCancel,
  onUndone,
}: RelinkHistoryDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [records, setRecords] = useState<WorkspaceRelinkRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [undoTarget, setUndoTarget] = useState<WorkspaceRelinkRecord | null>(
    null,
  );
  const [isUndoing, setIsUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const directoryId = directory?.directoryId ?? "";

  const loadRecords = useCallback(async (): Promise<void> => {
    if (!directoryId) {
      setRecords([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const items = await window.snow.listWorkspaceDirectoryRelinks(
        directoryId,
        50,
      );
      setRecords(items);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      setIsLoading(false);
    }
  }, [directoryId]);

  useEffect(() => {
    if (!directory) {
      setRecords([]);
      setUndoTarget(null);
      setError(null);
      return;
    }
    void loadRecords();
  }, [directory, loadRecords]);

  const handleUndoConfirm = useCallback((): void => {
    const target = undoTarget;
    if (!target || isUndoing) {
      return;
    }

    setIsUndoing(true);
    setError(null);

    void (async (): Promise<void> => {
      try {
        await window.snow.undoWorkspaceDirectoryRelink(target.relinkId);
        setUndoTarget(null);
        await loadRecords();
        onUndone();
      } catch (undoError) {
        setUndoTarget(null);
        setError(
          undoError instanceof Error ? undoError.message : String(undoError),
        );
      } finally {
        setIsUndoing(false);
      }
    })();
  }, [isUndoing, loadRecords, onUndone, undoTarget]);

  return (
    <>
      <FormDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        closeLabel={t("sidebar.close", { defaultValue: "Close" })}
        isSubmitting={isUndoing}
        onCancel={onCancel}
        open={directory !== null}
        showFooter={false}
        title={t("sidebar.relinkHistoryTitle", {
          defaultValue: "Relocation history",
        })}
      >
        {isLoading ? (
          <span className="form-dialog-description relink-directory-status">
            <Loader2 className="spin" size={12} />
            {t("sidebar.relinkHistoryLoading", {
              defaultValue: "Loading relocation history",
            })}
          </span>
        ) : records.length === 0 ? (
          <span className="form-dialog-description">
            {t("sidebar.relinkHistoryEmpty", {
              defaultValue:
                "This project has not been relocated. Records appear here after you move a project to a new folder.",
            })}
          </span>
        ) : (
          <div className="relink-history-list">
            {records.map((record) => (
              <div className="relink-history-item" key={record.relinkId}>
                <span className="relink-history-item-head">
                  <History size={12} />
                  <span className="relink-history-item-time">
                    {record.createdAt}
                  </span>
                  {record.undoneAt ? (
                    <span className="relink-history-item-undone">
                      {t("sidebar.relinkHistoryUndone", {
                        defaultValue: "Undone",
                      })}
                    </span>
                  ) : (
                    <button
                      className="relink-history-item-action"
                      disabled={isUndoing}
                      onClick={() => setUndoTarget(record)}
                      type="button"
                    >
                      <RotateCcw size={11} />
                      {t("sidebar.relinkHistoryUndo", {
                        defaultValue: "Undo",
                      })}
                    </button>
                  )}
                </span>
                <span className="relink-history-item-paths" title={record.newPath}>
                  <span className="relink-history-item-path">
                    {record.oldPath}
                  </span>
                  <ArrowRight size={11} />
                  <span className="relink-history-item-path">
                    {record.newPath}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
        {error ? <span className="form-dialog-error">{error}</span> : null}
      </FormDialog>
      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("sidebar.relinkHistoryUndo", { defaultValue: "Undo" })}
        message={t("sidebar.relinkHistoryUndoConfirm", {
          defaultValue:
            "Undo this relocation? The project and its history move back to the previous location.",
        })}
        onCancel={() => setUndoTarget(null)}
        onConfirm={handleUndoConfirm}
        open={undoTarget !== null}
        title={t("sidebar.relinkHistoryTitle", {
          defaultValue: "Relocation history",
        })}
      />
    </>
  );
}
