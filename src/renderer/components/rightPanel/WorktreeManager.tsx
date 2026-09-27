import { useCallback, useEffect, useState } from "react";
import { GitBranch, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { GitWorktreeInfo } from "../../../preload";
import { useI18n } from "../../i18n";
import { ConfirmDialog } from "../common/ConfirmDialog";

export function WorktreeManager({ directoryId }: { directoryId: string }): React.JSX.Element {
  const { t } = useI18n();
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [branchName, setBranchName] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removeTarget, setRemoveTarget] = useState<GitWorktreeInfo | null>(null);

  const refresh = useCallback((): void => {
    setError("");
    void window.snow.gitListWorktrees(directoryId)
      .then(setWorktrees)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [directoryId]);

  useEffect(() => refresh(), [refresh]);

  const notifyWorktreesChanged = (): void => {
    window.dispatchEvent(new Event("snow:worktrees-changed"));
  };

  const create = (): void => {
    if (!branchName.trim() || !baseRef.trim() || busy) return;
    setBusy(true);
    setError("");
    void window.snow.gitCreateWorktree(directoryId, branchName.trim(), baseRef.trim())
      .then((created) => {
        setWorktrees((items) => [...items.filter((item) => item.worktreeId !== created.worktreeId), created]);
        notifyWorktreesChanged();
        setBranchName("");
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const remove = (): void => {
    const target = removeTarget;
    if (!target || busy) return;
    setBusy(true);
    setError("");
    void window.snow.gitRemoveWorktree(directoryId, target.worktreeId)
      .then(() => {
        setRemoveTarget(null);
        notifyWorktreesChanged();
        refresh();
      })
      .catch((cause: unknown) => {
        const detail = cause instanceof Error ? cause.message : String(cause);
        setError(/dirty|modified|uncommitted|未提交|修改/i.test(detail)
          ? t("git.worktreeRemoveDirty")
          : detail || t("git.worktreeRemoveFailed"));
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="git-worktrees" aria-label={t("git.worktreesTitle")}>
      <header className="git-worktrees-header">
        <strong><GitBranch size={14} /> {t("git.worktreesTitle")}</strong>
        <button type="button" onClick={refresh} title={t("git.worktreesRefresh")}><RefreshCw size={13} /></button>
      </header>
      <form className="git-worktrees-create" onSubmit={(event) => { event.preventDefault(); create(); }}>
        <input aria-label={t("git.worktreeBranchName")} placeholder={t("git.worktreeBranchName")} value={branchName} onChange={(event) => setBranchName(event.target.value)} />
        <input aria-label={t("git.worktreeBaseRef")} placeholder={t("git.worktreeBaseRef")} value={baseRef} onChange={(event) => setBaseRef(event.target.value)} />
        <button type="submit" disabled={busy || !branchName.trim() || !baseRef.trim()} title={t("git.worktreeCreate")}><Plus size={14} /> {t("git.worktreeCreate")}</button>
      </form>
      {error ? <div role="alert" className="git-worktrees-error">{error}</div> : null}
      {worktrees.length ? (
        <ul className="git-worktrees-list">
          {worktrees.map((item) => (
            <li key={item.worktreeId} className={!item.isValid ? "is-invalid" : ""}>
              <div className="git-worktree-title-row">
                <strong>{item.branchName || t("git.graphDetachedHead")}</strong>
                {item.isDirty ? <span> · {t("git.worktreeDirty")}</span> : null}
                <button type="button" className="git-worktree-remove" disabled={busy} title={t("git.worktreeRemove")} aria-label={t("git.worktreeRemove")} onClick={() => setRemoveTarget(item)}><Trash2 size={13} /></button>
              </div>
              <code title={item.worktreePath}>{item.worktreePath}</code>
              <small>{item.isValid ? t("git.worktreeShareable") : t("git.worktreeInvalidPath")}{item.isDetached ? ` · ${t("git.graphDetachedHead")}` : ""}</small>
            </li>
          ))}
        </ul>
      ) : <p className="git-worktrees-empty">{t("git.worktreesEmpty")}</p>}
      <ConfirmDialog
        open={removeTarget !== null}
        variant="danger"
        title={t("git.worktreeRemoveTitle")}
        message={t("git.worktreeRemoveConfirm", { values: { branch: removeTarget?.branchName ?? removeTarget?.worktreePath ?? "" } })}
        confirmLabel={t("git.worktreeRemove")}
        cancelLabel={t("common.cancel")}
        onConfirm={remove}
        onCancel={() => setRemoveTarget(null)}
      />
    </section>
  );
}
