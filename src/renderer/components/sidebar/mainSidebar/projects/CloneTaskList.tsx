import { CircleAlert, Loader2, X } from "lucide-react";

import { useI18n } from "../../../../i18n";
import type { CloneTask } from "./cloneTasks";

type CloneTaskListProps = {
  tasks: CloneTask[];
  onAbort: (streamId: string) => void;
  onRemove: (streamId: string) => void;
};

/**
 * 克隆占位条目：弹窗关闭后仍在后台进行的克隆（以及失败待处理的克隆）
 * 以项目条目的形式展示 —— 进行中显示 spinner + 百分比并可中止，
 * 失败时显示原因并可移除。
 */
export function CloneTaskList({
  tasks,
  onAbort,
  onRemove,
}: CloneTaskListProps): React.JSX.Element | null {
  const { t } = useI18n();

  if (tasks.length === 0) {
    return null;
  }

  return (
    <ul className="clone-task-list">
      {tasks.map((task) => {
        const isFailed = task.status === "failed";
        const isAborting = task.status === "aborting";
        const percent = task.progress?.percent ?? null;

        const statusLabel = isFailed
          ? (task.error ??
            t("sidebar.cloneTaskFailed", { defaultValue: "Clone failed" }))
          : isAborting
            ? t("sidebar.cloneTaskAborting", { defaultValue: "Aborting…" })
            : percent !== null
              ? t("sidebar.cloneTaskProgress", {
                  defaultValue: "Cloning {{percent}}%",
                  values: { percent: percent.toFixed(0) },
                })
              : t("sidebar.cloneTaskCloning", { defaultValue: "Cloning…" });

        const statusTitle = isFailed
          ? (task.error ?? "")
          : (task.progress?.line ?? "");

        return (
          <li
            className={`clone-task-row${isFailed ? " is-failed" : ""}`}
            key={task.streamId}
          >
            {isFailed ? (
              <CircleAlert
                className="clone-task-icon"
                size={13}
                strokeWidth={1.9}
              />
            ) : (
              <Loader2
                className="clone-task-icon spin"
                size={13}
                strokeWidth={1.9}
              />
            )}
            <div className="clone-task-body" title={task.targetPath}>
              <span className="clone-task-name">{task.repoName}</span>
              <span className="clone-task-status" title={statusTitle}>
                {statusLabel}
              </span>
            </div>
            {isFailed ? (
              <button
                aria-label={t("sidebar.cloneTaskDismiss", {
                  defaultValue: "Dismiss",
                })}
                className="clone-task-action"
                onClick={() => onRemove(task.streamId)}
                title={t("sidebar.cloneTaskDismiss", { defaultValue: "Dismiss" })}
                type="button"
              >
                <X size={12} strokeWidth={2} />
              </button>
            ) : (
              <button
                aria-label={t("sidebar.cloneAbort", {
                  defaultValue: "Abort clone",
                })}
                className="clone-task-action"
                disabled={isAborting}
                onClick={() => onAbort(task.streamId)}
                title={t("sidebar.cloneAbort", { defaultValue: "Abort clone" })}
                type="button"
              >
                <X size={12} strokeWidth={2} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
