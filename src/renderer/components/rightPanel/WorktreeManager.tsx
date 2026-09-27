import { useCallback, useEffect, useState } from "react";
import { GitBranch, Plus, RefreshCw } from "lucide-react";
import type { GitWorktreeInfo } from "../../../preload";

export function WorktreeManager({ directoryId }: { directoryId: string }): React.JSX.Element {
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [branchName, setBranchName] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback((): void => {
    setError("");
    void window.snow.gitListWorktrees(directoryId)
      .then(setWorktrees)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [directoryId]);

  useEffect(() => refresh(), [refresh]);

  const create = (): void => {
    if (!branchName.trim() || !baseRef.trim() || busy) return;
    setBusy(true);
    setError("");
    void window.snow.gitCreateWorktree(directoryId, branchName.trim(), baseRef.trim())
      .then((created) => {
        setWorktrees((items) => [...items.filter((item) => item.worktreeId !== created.worktreeId), created]);
        window.dispatchEvent(new Event("snow:worktrees-changed"));
        setBranchName("");
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="git-worktrees" aria-label="项目 Worktree">
      <header className="git-worktrees-header">
        <strong><GitBranch size={14} /> Worktrees</strong>
        <button type="button" onClick={refresh} title="刷新 worktree 列表"><RefreshCw size={13} /></button>
      </header>
      <form className="git-worktrees-create" onSubmit={(event) => { event.preventDefault(); create(); }}>
        <input aria-label="新分支名称" placeholder="分支名称" value={branchName} onChange={(event) => setBranchName(event.target.value)} />
        <input aria-label="起始引用" placeholder="起始引用" value={baseRef} onChange={(event) => setBaseRef(event.target.value)} />
        <button type="submit" disabled={busy || !branchName.trim() || !baseRef.trim()} title="创建 worktree"><Plus size={14} /> 创建</button>
      </form>
      {error ? <div role="alert" className="git-worktrees-error">{error}</div> : null}
      {worktrees.length ? (
        <ul className="git-worktrees-list">
          {worktrees.map((item) => (
            <li key={item.worktreeId} className={!item.isValid ? "is-invalid" : ""}>
              <div><strong>{item.branchName || "detached"}</strong>{item.isDirty ? <span> · 有未提交修改</span> : null}</div>
              <code title={item.worktreePath}>{item.worktreePath}</code>
              <small>{item.isValid ? "可加入共享 worktree" : "路径无效"}{item.isDetached ? " · detached" : ""}</small>
            </li>
          ))}
        </ul>
      ) : <p className="git-worktrees-empty">此项目尚无 worktree</p>}
    </section>
  );
}
