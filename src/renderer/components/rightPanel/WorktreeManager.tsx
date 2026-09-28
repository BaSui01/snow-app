import { useCallback, useEffect, useState, useRef } from "react";
import {
  GitBranch,
  Plus,
  RefreshCw,
  Trash2,
  ChevronDown,
  Copy,
  Check,
  Folder,
  Terminal,
  FolderGit2,
  X,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import type { GitWorktreeInfo } from "../../../preload";
import { useI18n } from "../../i18n";
import { ConfirmDialog } from "../common/ConfirmDialog";

/** 清理 Windows 拓展长路径前缀 \\?\ 或 //?/，还原为干净美观的本地绝对路径。 */
const cleanWorktreePath = (rawPath: string): string => {
  if (!rawPath) return "";
  let cleaned = rawPath.replace(/^[\\/]{2}\?[\\/]/, "");
  cleaned = cleaned.replace(/^[\\/]+([a-zA-Z]:)/, "$1");
  return cleaned;
};

/** 提取末级工作树文件夹名称（如 chat, clone 等）。 */
const getFolderName = (p: string): string => {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
};

export function WorktreeManager({
  directoryId,
  onOpenTerminal,
}: {
  directoryId: string;
  onOpenTerminal?: (cwd: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [branchName, setBranchName] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removeTarget, setRemoveTarget] = useState<GitWorktreeInfo | null>(
    null,
  );
  const [showCreate, setShowCreate] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("snow:git:worktree-collapsed") === "true";
    } catch {
      return false;
    }
  });

  const branchInputRef = useRef<HTMLInputElement>(null);

  const toggleCollapsed = (): void => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("snow:git:worktree-collapsed", String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  };

  const refresh = useCallback((): void => {
    setError("");
    void window.snow
      .gitListWorktrees(directoryId)
      .then(setWorktrees)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [directoryId]);

  useEffect(() => refresh(), [refresh]);

  useEffect(() => {
    if (showCreate && !isCollapsed) {
      branchInputRef.current?.focus();
    }
  }, [showCreate, isCollapsed]);

  const notifyWorktreesChanged = (): void => {
    window.dispatchEvent(new Event("snow:worktrees-changed"));
  };

  const create = (): void => {
    if (!branchName.trim() || !baseRef.trim() || busy) return;
    setBusy(true);
    setError("");
    void window.snow
      .gitCreateWorktree(directoryId, branchName.trim(), baseRef.trim())
      .then((created) => {
        setWorktrees((items) => [
          ...items.filter((item) => item.worktreeId !== created.worktreeId),
          created,
        ]);
        notifyWorktreesChanged();
        setBranchName("");
        setShowCreate(false);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setBusy(false));
  };

  const remove = (): void => {
    const target = removeTarget;
    if (!target || busy) return;
    setBusy(true);
    setError("");
    void window.snow
      .gitRemoveWorktree(directoryId, target.worktreeId)
      .then(() => {
        setRemoveTarget(null);
        notifyWorktreesChanged();
        refresh();
      })
      .catch((cause: unknown) => {
        const detail = cause instanceof Error ? cause.message : String(cause);
        setError(
          /dirty|modified|uncommitted|未提交|修改/i.test(detail)
            ? t("git.worktreeRemoveDirty")
            : detail || t("git.worktreeRemoveFailed"),
        );
      })
      .finally(() => setBusy(false));
  };

  const handleCopyPath = (id: string, path: string): void => {
    void window.snow.writeClipboardText(path).then(() => {
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 1500);
    });
  };

  return (
    <section className="git-worktrees" aria-label={t("git.worktreesTitle")}>
      <header
        className="git-worktrees-header"
        onClick={toggleCollapsed}
        title={
          isCollapsed
            ? t("common.expand", { defaultValue: "展开工作树" })
            : t("common.collapse", { defaultValue: "折叠工作树" })
        }
      >
        <button
          type="button"
          className={`git-worktrees-collapse-btn ${isCollapsed ? "is-collapsed" : ""}`}
          aria-expanded={!isCollapsed}
          tabIndex={-1}
        >
          <ChevronDown size={13} />
        </button>
        <strong>
          <GitBranch size={13} className="worktree-header-icon" />
          <span>{t("git.worktreesTitle")}</span>
          {worktrees.length > 0 && (
            <span className="git-worktree-count-badge">{worktrees.length}</span>
          )}
        </strong>
        <div
          className="git-worktrees-header-actions"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className={`git-worktrees-header-btn ${showCreate ? "is-active" : ""}`}
            onClick={() => {
              if (isCollapsed) setIsCollapsed(false);
              setShowCreate((v) => !v);
            }}
            title={showCreate ? t("common.cancel") : t("git.worktreeCreate")}
            aria-label={t("git.worktreeCreate")}
          >
            <Plus size={13} className={showCreate ? "rotate-45" : ""} />
          </button>
          <button
            type="button"
            className="git-worktrees-header-btn"
            onClick={refresh}
            title={t("git.worktreesRefresh")}
            aria-label={t("git.worktreesRefresh")}
          >
            <RefreshCw size={12} className={busy ? "spin" : ""} />
          </button>
        </div>
      </header>

      {!isCollapsed && (
        <div className="git-worktrees-body">
          {showCreate && (
            <form
              className="git-worktree-create-panel"
              onSubmit={(event) => {
                event.preventDefault();
                create();
              }}
            >
              <div className="git-worktree-create-header">
                <span>{t("git.worktreeCreate")}</span>
                <button
                  type="button"
                  className="git-worktree-close-btn"
                  onClick={() => setShowCreate(false)}
                  title={t("common.cancel")}
                >
                  <X size={12} />
                </button>
              </div>

              <div className="git-worktree-create-fields">
                <input
                  ref={branchInputRef}
                  type="text"
                  aria-label={t("git.worktreeBranchName")}
                  placeholder={
                    t("git.worktreeBranchName") + " (如 feature/new-task)"
                  }
                  value={branchName}
                  onChange={(event) => setBranchName(event.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setShowCreate(false);
                    }
                  }}
                  disabled={busy}
                  spellCheck={false}
                  autoComplete="off"
                />
                <input
                  type="text"
                  aria-label={t("git.worktreeBaseRef")}
                  placeholder={t("git.worktreeBaseRef") + " (默认 HEAD)"}
                  value={baseRef}
                  onChange={(event) => setBaseRef(event.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setShowCreate(false);
                    }
                  }}
                  disabled={busy}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>

              <div className="git-worktree-create-footer">
                <span className="git-worktree-create-hint">
                  {t("git.worktreeShareable")}
                </span>
                <div className="git-worktree-create-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setShowCreate(false)}
                    disabled={busy}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={busy || !branchName.trim() || !baseRef.trim()}
                  >
                    {busy ? (
                      <Loader2 size={12} className="spin" />
                    ) : (
                      <Plus size={12} />
                    )}
                    {t("git.worktreeCreate")}
                  </button>
                </div>
              </div>
            </form>
          )}

          {error ? (
            <div role="alert" className="git-worktrees-error">
              <AlertCircle size={13} className="flex-shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {worktrees.length > 0 ? (
            <ul className="git-worktrees-list">
              {worktrees.map((item) => {
                const cleanedPath = cleanWorktreePath(item.worktreePath);
                const folderName = getFolderName(cleanedPath);
                const isCopied = copiedId === item.worktreeId;

                return (
                  <li
                    key={item.worktreeId}
                    className={`git-worktree-card ${!item.isValid ? "is-invalid" : ""}`}
                  >
                    <div className="git-worktree-card-top">
                      <div
                        className="git-worktree-branch-badge"
                        title={item.branchName || t("git.graphDetachedHead")}
                      >
                        <GitBranch size={12} className="worktree-branch-icon" />
                        <strong>
                          {item.branchName || t("git.graphDetachedHead")}
                        </strong>
                      </div>

                      <div className="git-worktree-status-group">
                        {item.isDirty ? (
                          <span
                            className="worktree-status-badge is-dirty"
                            title={t("git.worktreeDirty")}
                          >
                            <AlertCircle size={10} />
                            {t("git.worktreeDirty")}
                          </span>
                        ) : item.isValid ? (
                          <span
                            className="worktree-status-badge is-clean"
                            title={t("git.graphWorktreeClean", {
                              defaultValue: "工作区干净",
                            })}
                          >
                            <CheckCircle2 size={10} />
                            {t("git.graphWorktreeClean", {
                              defaultValue: "干净",
                            })}
                          </span>
                        ) : (
                          <span
                            className="worktree-status-badge is-invalid"
                            title={t("git.worktreeInvalidPath")}
                          >
                            <AlertCircle size={10} />
                            {t("git.worktreeInvalidPath")}
                          </span>
                        )}
                      </div>

                      <div className="git-worktree-card-actions">
                        <button
                          type="button"
                          className={`git-worktree-action-btn ${isCopied ? "is-copied" : ""}`}
                          title={
                            isCopied
                              ? t("common.copied", {
                                  defaultValue: "已复制路径",
                                })
                              : t("git.copyWorktreePath", {
                                  defaultValue: "复制工作树路径",
                                })
                          }
                          aria-label={t("git.copyWorktreePath", {
                            defaultValue: "复制工作树路径",
                          })}
                          onClick={() =>
                            handleCopyPath(item.worktreeId, cleanedPath)
                          }
                        >
                          {isCopied ? (
                            <Check size={12} className="text-success" />
                          ) : (
                            <Copy size={12} />
                          )}
                        </button>

                        <button
                          type="button"
                          className="git-worktree-action-btn"
                          title={t("plugins.openFolder", {
                            defaultValue: "在文件夹中显示",
                          })}
                          aria-label={t("plugins.openFolder", {
                            defaultValue: "在文件夹中显示",
                          })}
                          onClick={() => {
                            void window.snow
                              .showItemInFolder(cleanedPath)
                              .catch(() => {});
                          }}
                        >
                          <Folder size={12} />
                        </button>

                        {onOpenTerminal && (
                          <button
                            type="button"
                            className="git-worktree-action-btn"
                            title={t("git.openInTerminal", {
                              defaultValue: "在终端中打开",
                            })}
                            aria-label={t("git.openInTerminal", {
                              defaultValue: "在终端中打开",
                            })}
                            onClick={() => onOpenTerminal(cleanedPath)}
                          >
                            <Terminal size={12} />
                          </button>
                        )}

                        <button
                          type="button"
                          className="git-worktree-action-btn is-danger"
                          disabled={busy}
                          title={t("git.worktreeRemove")}
                          aria-label={t("git.worktreeRemove")}
                          onClick={() => setRemoveTarget(item)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>

                    <div className="git-worktree-card-path">
                      <span className="worktree-folder-tag" title={folderName}>
                        <FolderGit2 size={10} />
                        {folderName}
                      </span>
                      <code title={cleanedPath}>{cleanedPath}</code>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="git-worktrees-empty-box">
              <FolderGit2 size={24} className="empty-icon" />
              <p>{t("git.worktreesEmpty")}</p>
              <button
                type="button"
                className="btn-empty-action"
                onClick={() => setShowCreate(true)}
              >
                <Plus size={12} />
                <span>{t("git.worktreeCreate")}</span>
              </button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        variant="danger"
        title={t("git.worktreeRemoveTitle")}
        message={t("git.worktreeRemoveConfirm", {
          values: {
            branch:
              removeTarget?.branchName ?? removeTarget?.worktreePath ?? "",
          },
        })}
        confirmLabel={t("git.worktreeRemove")}
        cancelLabel={t("common.cancel")}
        onConfirm={remove}
        onCancel={() => setRemoveTarget(null)}
      />
    </section>
  );
}
