import { useEffect, useState } from "react";
import { GitBranch, Link2, Unlink } from "lucide-react";
import type { GitWorktreeInfo } from "../../../../preload";
import { useChatConversationContext } from "../chatMessages";

export function WorktreeSessionSelector(): React.JSX.Element | null {
  const { activeConversationId, conversationDirectoryId } =
    useChatConversationContext();
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [current, setCurrent] = useState<GitWorktreeInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!activeConversationId || !conversationDirectoryId) {
      setCurrent(null);
      setWorktrees([]);
      return;
    }
    setCurrent(null);
    setError("");
    void Promise.all([
      window.snow.gitListWorktrees(conversationDirectoryId),
      window.snow.getConversationWorktree(activeConversationId),
    ]).then(([items, bound]) => {
      if (!cancelled) {
        setWorktrees(items);
        setCurrent(bound);
      }
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [activeConversationId, conversationDirectoryId]);

  useEffect(() => {
    if (!activeConversationId || !conversationDirectoryId) return;
    const reload = (): void => {
      void Promise.all([
        window.snow.gitListWorktrees(conversationDirectoryId),
        window.snow.getConversationWorktree(activeConversationId),
      ]).then(([items, bound]) => {
        setWorktrees(items);
        setCurrent(bound);
      }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    };
    window.addEventListener("snow:worktrees-changed", reload);
    return () => window.removeEventListener("snow:worktrees-changed", reload);
  }, [activeConversationId, conversationDirectoryId]);

  if (!activeConversationId || !conversationDirectoryId) return null;

  const bind = (worktreeId: string | null): void => {
    setError("");
    void window.snow.setConversationWorktree(activeConversationId, worktreeId)
      .then(() => setCurrent(worktrees.find((item) => item.worktreeId === worktreeId) ?? null))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <div className="worktree-session-selector" title={current?.worktreePath ?? "未绑定 worktree"}>
      <GitBranch size={13} aria-hidden="true" />
      <select
        aria-label="当前会话 worktree"
        value={current?.worktreeId ?? ""}
        onChange={(event) => bind(event.target.value || null)}
      >
        <option value="">未绑定 worktree</option>
        {worktrees.map((item) => (
          <option key={item.worktreeId} value={item.worktreeId}>
            {item.branchName || "detached"} · {item.worktreePath}
          </option>
        ))}
      </select>
      {current ? (
        <span
          className="worktree-session-status"
          title={`${current.worktreePath} · ${current.branchName ?? "detached"}${current.isDirty ? " · 有未提交修改" : ""}`}
        >
          <Link2 size={12} />
          <span>已加入 · {current.branchName || "detached"}</span>
          <small title={current.worktreePath}>{current.worktreePath}</small>
          {current.isDirty ? <small>有未提交修改</small> : null}
          <button
            type="button"
            aria-label="解绑 worktree"
            title="解绑 worktree"
            onClick={() => bind(null)}
          >
            <Unlink size={12} />
          </button>
        </span>
      ) : null}
      {error ? <span role="alert" title={error}>Worktree 操作失败</span> : null}
    </div>
  );
}
