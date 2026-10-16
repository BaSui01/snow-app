import {
  AlertCircle,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Download,
  FolderOpen,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import {
  localizeSshError,
  localizeSshTransferError,
} from "../../utils/sshErrorMessages";
import type {
  SshTransferSnapshot,
  SshTransferStatus,
  SshTransferTaskSnapshot,
} from "../../../preload";

/** 终态：任务不再变化，全部结束后由面板的「结束」按钮统一清理。 */
const TERMINAL_STATUSES: ReadonlySet<SshTransferStatus> = new Set([
  "succeeded",
  "skipped",
  "failed",
  "cancelled",
  "commit-unknown",
]);

/** 任务状态 → i18n 文案 key（与 lang 三语文件保持一致）。 */
const STATUS_LABEL_KEYS: Record<SshTransferStatus, string> = {
  queued: "explorer.transferStatusQueued",
  preparing: "explorer.transferStatusPreparing",
  "awaiting-conflict": "explorer.transferStatusAwaitingConflict",
  transferring: "explorer.transferStatusTransferring",
  verifying: "explorer.transferStatusVerifying",
  committing: "explorer.transferStatusCommitting",
  succeeded: "explorer.transferStatusSucceeded",
  skipped: "explorer.transferStatusSkipped",
  failed: "explorer.transferStatusFailed",
  cancelled: "explorer.transferStatusCancelled",
  "commit-unknown": "explorer.transferStatusCommitUnknown",
};

const isTerminalStatus = (status: SshTransferStatus): boolean =>
  TERMINAL_STATUSES.has(status);

/** 字节数格式化：512 B / 1.5 KB / 2.3 MB / 1.2 GB。 */
const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
};

/**
 * SSH 传输面板：资源管理器底部的进度条 + 冲突协商浮层。
 *
 * 自包含：挂载时先拉取一次快照，随后完全依赖主进程推送；用 snapshot.version
 * 单调去重（迟到的旧版本直接忽略）。无任务时不渲染任何内容。
 */
export function SshTransfersPanel(): React.JSX.Element | null {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<SshTransferSnapshot | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const versionRef = useRef(-1);

  // 冲突协商表单：输入框、勾选、提交中与错误提示。
  const [renameInput, setRenameInput] = useState("");
  const [applyToBatch, setApplyToBatch] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
  // 当前表单对应的「任务 + 冲突轮次」：变化时重置输入框与勾选。
  const conflictKeyRef = useRef<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  /** 应用快照：version 单调，忽略迟到的旧版本。 */
  const applySnapshot = useCallback((next: SshTransferSnapshot): void => {
    if (next.version < versionRef.current) {
      return;
    }
    versionRef.current = next.version;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    let disposed = false;
    // 挂载先拉一次当前快照（面板重新挂载 / 切换显示位置后补齐状态）。
    void window.snow
      .sshListTransfers()
      .then((next) => {
        if (!disposed) {
          applySnapshot(next);
        }
      })
      .catch(() => {
        // 拉取失败静默忽略：后续推送仍会补齐状态。
      });
    const unsubscribe = window.snow.onSshTransfersUpdated((next) => {
      applySnapshot(next);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [applySnapshot]);

  const tasks = useMemo(() => snapshot?.tasks ?? [], [snapshot]);

  const activeCount = useMemo(
    () => tasks.filter((task) => !isTerminalStatus(task.status)).length,
    [tasks],
  );
  const failedCount = useMemo(
    () => tasks.filter((task) => task.status === "failed").length,
    [tasks],
  );

  // 可能同时存在多个冲突，取 startedAt 最早的任务先行协商。
  const conflictTask = useMemo<SshTransferTaskSnapshot | null>(() => {
    const pending = tasks.filter(
      (task) => task.status === "awaiting-conflict" && task.conflict,
    );
    if (pending.length === 0) {
      return null;
    }
    return pending.reduce((earliest, task) =>
      task.startedAt < earliest.startedAt ? task : earliest,
    );
  }, [tasks]);

  // 任务或冲突轮次变化时重置表单：默认填入建议名称。
  useEffect(() => {
    if (!conflictTask?.conflict) {
      conflictKeyRef.current = null;
      setConflictError(null);
      return;
    }
    const key = `${conflictTask.taskId}:${conflictTask.conflict.rounds}`;
    if (conflictKeyRef.current === key) {
      return;
    }
    conflictKeyRef.current = key;
    setRenameInput(conflictTask.conflict.suggestedName);
    setApplyToBatch(false);
    setConflictError(null);
    // 输入框在本次提交中渲染出来，聚焦便于直接改名。
    window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  }, [conflictTask]);

  const handleCancelTask = useCallback((taskId: string): void => {
    void window.snow.sshCancelTransfer({ taskId }).catch(() => {
      // 取消失败静默忽略：任务状态仍由主进程推送刷新。
    });
  }, []);

  /** 「全部取消」：逐个取消所有非终态任务。 */
  const handleCancelAll = useCallback((): void => {
    for (const task of tasks) {
      if (isTerminalStatus(task.status)) {
        continue;
      }
      void window.snow.sshCancelTransfer({ taskId: task.taskId }).catch(() => {
        // 取消失败静默忽略。
      });
    }
  }, [tasks]);

  const handleClearFinished = useCallback((): void => {
    void window.snow.sshClearFinishedTransfers().catch(() => {
      // 清除失败静默忽略。
    });
  }, []);

  const handleShowInFolder = useCallback((path: string): void => {
    void window.snow.showItemInFolder(path).catch(() => {
      // 文件可能已被移动 / 删除：静默忽略。
    });
  }, []);

  /** 回答冲突协商；IPC 失败时在卡片内提示，不关闭卡片。 */
  const handleResolveConflict = useCallback(
    async (action: "replace" | "skip" | "rename"): Promise<void> => {
      if (!conflictTask) {
        return;
      }
      setIsResolving(true);
      setConflictError(null);
      try {
        await window.snow.sshResolveTransferConflict({
          taskId: conflictTask.taskId,
          action,
          // 重命名留空时交给主进程使用建议名称。
          newName:
            action === "rename" ? renameInput.trim() || undefined : undefined,
          applyToBatch,
        });
      } catch (error) {
        setConflictError(localizeSshError(error, t).message);
      } finally {
        setIsResolving(false);
      }
    },
    [conflictTask, renameInput, applyToBatch, t],
  );

  // 无任务时不渲染（本地工作区零影响）。
  if (!snapshot || tasks.length === 0) {
    return null;
  }

  const conflictInfo = conflictTask?.conflict ?? null;
  const summaryText =
    activeCount > 0
      ? t("explorer.transfersSummary", {
          values: { active: activeCount, failed: failedCount },
        })
      : t("explorer.transfersAllDone");

  return (
    <div className="ssh-transfers">
      {conflictTask && conflictInfo ? (
        <div
          className="ssh-transfer-conflict"
          role="alertdialog"
          aria-label={t("explorer.transferConflictTitle")}
        >
          <div className="ssh-transfer-conflict-header">
            <AlertCircle size={14} aria-hidden="true" />
            <span>{t("explorer.transferConflictTitle")}</span>
          </div>
          <div className="ssh-transfer-conflict-message">
            {t("explorer.transferConflictMessage", {
              values: { name: conflictInfo.baseName },
            })}
          </div>
          <div
            className="ssh-transfer-conflict-path"
            title={conflictInfo.targetPath}
          >
            {conflictInfo.targetPath}
          </div>
          <label
            className="ssh-transfer-conflict-field"
            htmlFor="ssh-transfer-conflict-name"
          >
            <span>{t("explorer.transferConflictNameLabel")}</span>
            <input
              id="ssh-transfer-conflict-name"
              ref={renameInputRef}
              type="text"
              value={renameInput}
              onChange={(event) => setRenameInput(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="ssh-transfer-conflict-apply-all">
            <input
              type="checkbox"
              checked={applyToBatch}
              onChange={(event) => setApplyToBatch(event.target.checked)}
            />
            <span>{t("explorer.transferConflictApplyAll")}</span>
          </label>
          {conflictError ? (
            <div className="ssh-transfer-conflict-error">{conflictError}</div>
          ) : null}
          <div className="ssh-transfer-conflict-actions">
            <button
              type="button"
              className="primary"
              disabled={isResolving}
              onClick={() => void handleResolveConflict("replace")}
            >
              {t("explorer.transferConflictReplace")}
            </button>
            <button
              type="button"
              disabled={isResolving}
              onClick={() => void handleResolveConflict("skip")}
            >
              {t("explorer.transferConflictSkip")}
            </button>
            <button
              type="button"
              disabled={isResolving || renameInput.trim().length === 0}
              onClick={() => void handleResolveConflict("rename")}
            >
              {t("explorer.transferConflictRename")}
            </button>
            <button
              type="button"
              disabled={isResolving}
              onClick={() => handleCancelTask(conflictTask.taskId)}
            >
              {t("explorer.transferConflictCancelTask")}
            </button>
          </div>
        </div>
      ) : null}

      {isExpanded ? (
        <div className="ssh-transfers-list">
          {tasks.map((task) => {
            const isActive = !isTerminalStatus(task.status);
            const errorText = localizeSshTransferError(task.error, t);
            const downloadPath =
              task.direction === "download" &&
              task.status === "succeeded" &&
              task.finalPath
                ? task.finalPath
                : null;
            // bytesTotal 缺失（如仍在校验 / 预扫描）时不显示进度条，仅显示状态文字。
            const hasProgress =
              typeof task.bytesTotal === "number" && task.bytesTotal > 0;
            const percent = hasProgress
              ? Math.min(
                  100,
                  Math.round(
                    (task.bytesTransferred / (task.bytesTotal ?? 1)) * 100,
                  ),
                )
              : 0;
            return (
              <div
                className={`ssh-transfers-item status-${task.status}`}
                key={task.taskId}
              >
                <span className="ssh-transfers-item-icon" aria-hidden="true">
                  {task.direction === "upload" ? (
                    <Upload size={13} />
                  ) : (
                    <Download size={13} />
                  )}
                </span>
                <div className="ssh-transfers-item-body">
                  <div className="ssh-transfers-item-head">
                    <span
                      className="ssh-transfers-item-name"
                      title={task.finalPath ?? task.remotePath}
                    >
                      {task.name}
                    </span>
                    <span className="ssh-transfers-item-status">
                      {t(STATUS_LABEL_KEYS[task.status])}
                    </span>
                  </div>
                  {hasProgress ? (
                    <div className="ssh-transfers-item-progress">
                      <div className="ssh-transfers-progress-track">
                        <div
                          className="ssh-transfers-progress-bar"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <span className="ssh-transfers-progress-text">
                        {t("explorer.transferBytes", {
                          values: {
                            done: formatBytes(task.bytesTransferred),
                            total: formatBytes(task.bytesTotal ?? 0),
                          },
                        })}
                      </span>
                    </div>
                  ) : null}
                  {errorText ? (
                    <div className="ssh-transfers-item-error">{errorText}</div>
                  ) : null}
                </div>
                <div className="ssh-transfers-item-actions">
                  {downloadPath ? (
                    <button
                      type="button"
                      className="ssh-transfers-icon-btn"
                      title={t("explorer.transferOpenFolder")}
                      aria-label={t("explorer.transferOpenFolder")}
                      onClick={() => handleShowInFolder(downloadPath)}
                    >
                      <FolderOpen size={13} />
                    </button>
                  ) : null}
                  {isActive ? (
                    <button
                      type="button"
                      className="ssh-transfers-icon-btn"
                      title={t("explorer.transferCancel")}
                      aria-label={t("explorer.transferCancel")}
                      onClick={() => handleCancelTask(task.taskId)}
                    >
                      <X size={13} />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="ssh-transfers-bar">
        <button
          type="button"
          className="ssh-transfers-toggle"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded((prev) => !prev)}
        >
          <ArrowUpDown
            size={13}
            className="ssh-transfers-header-icon"
            aria-hidden="true"
          />
          <span className="ssh-transfers-title">
            {t("explorer.transfersTitle")}
          </span>
          <span className="ssh-transfers-summary">{summaryText}</span>
          {isExpanded ? (
            <ChevronDown size={13} className="ssh-transfers-chevron" />
          ) : (
            <ChevronUp size={13} className="ssh-transfers-chevron" />
          )}
        </button>
        {activeCount === 0 ? (
          <button
            type="button"
            className="ssh-transfers-text-btn"
            onClick={handleClearFinished}
          >
            {t("explorer.transferDismiss")}
          </button>
        ) : null}
        {activeCount > 0 ? (
          <button
            type="button"
            className="ssh-transfers-text-btn"
            onClick={handleCancelAll}
          >
            {t("explorer.transferCancelAll")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
