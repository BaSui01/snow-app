import { useEffect, useRef, useState } from "react";
import { GitBranch, Link2, Unlink } from "lucide-react";
import type { GitWorktreeInfo } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { useChatConversationContext } from "../chatMessages";

export function WorktreeSessionSelector(): React.JSX.Element | null {
  const { activeConversationId, conversationDirectoryId, worktreeMode } =
    useChatConversationContext();
  const { t } = useI18n();
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [current, setCurrent] = useState<GitWorktreeInfo | null>(null);
  const [hasError, setHasError] = useState(false);
  const requestGenerationRef = useRef(0);
  const activeContextRef = useRef({
    conversationId: activeConversationId,
    directoryId: conversationDirectoryId,
  });
  activeContextRef.current = {
    conversationId: activeConversationId,
    directoryId: conversationDirectoryId,
  };

  const isCurrentRequest = (
    conversationId: string,
    directoryId: string,
    generation: number,
  ): boolean =>
    requestGenerationRef.current === generation &&
    activeContextRef.current.conversationId === conversationId &&
    activeContextRef.current.directoryId === directoryId;

  useEffect(() => {
    const conversationId = activeConversationId;
    const directoryId = conversationDirectoryId;
    if (!conversationId || !directoryId) {
      requestGenerationRef.current += 1;
      setCurrent(null);
      setWorktrees([]);
      setHasError(false);
      return;
    }

    setCurrent(null);
    setHasError(false);
    const reload = (): void => {
      const generation = ++requestGenerationRef.current;
      void Promise.all([
        window.snow.gitListWorktrees(directoryId),
        window.snow.getConversationWorktree(conversationId),
      ])
        .then(([items, bound]) => {
          if (!isCurrentRequest(conversationId, directoryId, generation))
            return;
          setWorktrees(items);
          setCurrent(bound);
          setHasError(false);
        })
        .catch(() => {
          if (isCurrentRequest(conversationId, directoryId, generation)) {
            setHasError(true);
          }
        });
    };

    reload();
    window.addEventListener("snow:worktrees-changed", reload);
    return () => {
      requestGenerationRef.current += 1;
      window.removeEventListener("snow:worktrees-changed", reload);
    };
  }, [activeConversationId, conversationDirectoryId]);

  if (!conversationDirectoryId) return null;
  if (!activeConversationId) {
    return worktreeMode ? (
      <div className="worktree-session-selector" role="status">
        <GitBranch size={13} aria-hidden="true" />
        <span>{t("git.worktreesPendingSessionHint")}</span>
      </div>
    ) : null;
  }

  const bind = (worktreeId: string | null): void => {
    const conversationId = activeConversationId;
    const directoryId = conversationDirectoryId;
    const generation = ++requestGenerationRef.current;
    setHasError(false);
    void window.snow
      .setConversationWorktree(conversationId, worktreeId)
      .then(() => {
        if (!isCurrentRequest(conversationId, directoryId, generation)) return;
        setCurrent(
          worktrees.find((item) => item.worktreeId === worktreeId) ?? null,
        );
      })
      .catch(() => {
        if (isCurrentRequest(conversationId, directoryId, generation)) {
          setHasError(true);
        }
      });
  };

  const branchName = current?.branchName ?? t("git.graphDetachedHead");
  const currentTitle = current
    ? t("git.worktreesSessionStatus", {
        values: {
          path: current.worktreePath,
          branch: branchName,
          dirty: current.isDirty ? ` · ${t("git.worktreeDirty")}` : "",
        },
      })
    : t("git.worktreesUnbound");

  return (
    <div className="worktree-session-selector" title={currentTitle}>
      <GitBranch size={13} aria-hidden="true" />
      <select
        aria-label={t("git.worktreesSessionSelector")}
        value={current?.worktreeId ?? ""}
        onChange={(event) => bind(event.target.value || null)}
      >
        <option value="">{t("git.worktreesUnbound")}</option>
        {worktrees.map((item) => (
          <option key={item.worktreeId} value={item.worktreeId}>
            {item.branchName || t("git.graphDetachedHead")} ·{" "}
            {item.worktreePath}
          </option>
        ))}
      </select>
      {current ? (
        <span className="worktree-session-status" title={currentTitle}>
          <Link2 size={12} />
          <span>
            {t("git.worktreesSessionBound", { values: { branch: branchName } })}
          </span>
          <small title={current.worktreePath}>{current.worktreePath}</small>
          {current.isDirty ? <small>{t("git.worktreeDirty")}</small> : null}
          <button
            type="button"
            aria-label={t("git.worktreesUnbind")}
            title={t("git.worktreesUnbind")}
            onClick={() => bind(null)}
          >
            <Unlink size={12} />
          </button>
        </span>
      ) : null}
      {hasError ? (
        <span role="alert">{t("git.worktreesOperationFailed")}</span>
      ) : null}
    </div>
  );
}
