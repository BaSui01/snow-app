import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { GitBranchPlus, Pencil, Trash2 } from "lucide-react";
import type { GitBranch } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import type { ContextMenuItem } from "../../common/ContextMenu";
import { useChatConversationContext } from "../../mainContent/chatMessages";

export const BRANCHES_CHANGED = "snow:branches-changed";
const busyRepos = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const notify = (): void => {
  listeners.forEach((listener) => listener());
};

/** Shared menu/dialog/controller for every actual branch-management surface. */
export function useBranchManagement(
  repoPath: string,
  onChanged: () => void,
  running = false,
) {
  const { t } = useI18n();
  let chat: ReturnType<typeof useChatConversationContext> | null = null;
  try {
    chat = useChatConversationContext();
  } catch {
    /* This surface may be rendered without an active chat provider. */
  }
  const sessionRunning =
    running ||
    Boolean(chat?.isStreaming || chat?.isAborting || chat?.isCompacting);
  const runningRef = useRef(sessionRunning);
  runningRef.current = sessionRunning;
  const busy = useSyncExternalStore(subscribe, () => busyRepos.has(repoPath));
  const [ownBusy, setOwnBusy] = useState(false);
  const [target, setTarget] = useState<{
    branch: GitBranch;
    action: "create" | "rename" | "delete";
  } | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const current = useRef(repoPath);
  const generation = useRef(0);
  if (current.current !== repoPath) {
    current.current = repoPath;
    generation.current++;
  }
  useEffect(() => {
    setOwnBusy(false);
    setTarget(null);
    setName("");
    setError(null);
    return () => {
      generation.current++;
    };
  }, [repoPath]);

  const execute = async (
    operation: () => Promise<{ success: boolean; message: string }>,
  ): Promise<void> => {
    if (
      busyRepos.has(repoPath) ||
      sessionRunning ||
      current.current !== repoPath
    )
      return;
    const token = generation.current;
    setOwnBusy(true);
    busyRepos.add(repoPath);
    notify();
    setError(null);
    try {
      const result = await operation();
      if (result.success) {
        window.dispatchEvent(
          new CustomEvent(BRANCHES_CHANGED, { detail: repoPath }),
        );
      }
      if (token !== generation.current || current.current !== repoPath) return;
      if (!result.success) {
        setError(result.message || t("git.operationFailedGeneric"));
        return;
      }
      setTarget(null);
      onChanged();
    } catch (cause) {
      if (token === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === generation.current) setOwnBusy(false);
      busyRepos.delete(repoPath);
      notify();
    }
  };

  const checkout = (branch: GitBranch): void => {
    if (branch.isCurrent || (!branch.isRemote && branch.worktreePath)) return;
    void execute(async () => {
      const token = generation.current;
      const branches = await window.snow.gitBranches(repoPath);
      if (
        token !== generation.current ||
        current.current !== repoPath ||
        runningRef.current
      )
        return { success: false, message: t("git.operationFailedGeneric") };
      const latest = branches.find(
        (item) =>
          item.name === branch.name && item.isRemote === branch.isRemote,
      );
      if (!latest) return { success: false, message: t("git.manageMissing") };
      if (latest.isCurrent || latest.worktreePath)
        return { success: false, message: t("git.manageOccupied") };
      let checkoutName = branch.name;
      if (branch.isRemote) {
        if (!branch.remoteName)
          return { success: false, message: t("git.manageMissing") };
        const localName = branch.name.slice(branch.remoteName.length + 1);
        const local = branches.find(
          (item) => !item.isRemote && item.name === localName,
        );
        if (local && (local.worktreePath || local.upstream !== branch.name))
          return { success: false, message: t("git.manageTrackingConflict") };
        checkoutName = local?.name ?? branch.name;
      }
      return window.snow.gitCheckout(repoPath, checkoutName);
    });
  };
  const menuItems = (
    branch: GitBranch,
    close: () => void,
  ): ContextMenuItem[] => {
    const open = (action: "create" | "rename" | "delete"): void => {
      close();
      setError(null);
      setName(action === "rename" ? branch.name : "");
      setTarget({ branch, action });
    };
    const disabled = busy || sessionRunning;
    return [
      {
        id: "branch-create-from",
        separator: true,
        label: t(branch.isRemote ? "git.manageTrack" : "git.manageCreate"),
        icon: <GitBranchPlus size={13} />,
        disabled,
        onClick: () => open("create"),
      },
      ...(!branch.isRemote
        ? [
            {
              id: "branch-rename",
              label: t("git.manageRename"),
              icon: <Pencil size={13} />,
              disabled:
                disabled || branch.isCurrent || Boolean(branch.worktreePath),
              onClick: () => open("rename"),
            },
            {
              id: "branch-delete",
              label: t("git.manageDelete"),
              icon: <Trash2 size={13} />,
              danger: true,
              disabled:
                disabled || branch.isCurrent || Boolean(branch.worktreePath),
              onClick: () => open("delete"),
            },
          ]
        : []),
    ];
  };
  const confirm = (): void => {
    if (!target || busy || sessionRunning) return;
    const { branch, action } = target;
    if (
      action !== "delete" &&
      (!name || name.trim() !== name || name.startsWith("-"))
    ) {
      setError(t("git.createBranchInvalid"));
      return;
    }
    void execute(async () => {
      // Re-read occupancy immediately before mutation, not from a stale open menu.
      const token = generation.current;
      const branches = await window.snow.gitBranches(repoPath);
      if (
        token !== generation.current ||
        current.current !== repoPath ||
        runningRef.current
      )
        return { success: false, message: t("git.operationFailedGeneric") };
      const latest = branches.find(
        (item) =>
          item.name === branch.name && item.isRemote === branch.isRemote,
      );
      if (!latest) return { success: false, message: t("git.manageMissing") };
      if (action !== "create" && (latest.isCurrent || latest.worktreePath))
        return { success: false, message: t("git.manageOccupied") };
      return window.snow.gitManageBranch(
        repoPath,
        action,
        branch.name,
        action === "delete" ? undefined : name,
        branch.isRemote,
      );
    });
  };
  const title = target
    ? t(
        target.action === "create"
          ? target.branch.isRemote
            ? "git.manageTrack"
            : "git.manageCreate"
          : target.action === "rename"
            ? "git.manageRename"
            : "git.manageDelete",
      )
    : t(ownBusy ? "git.manageBusy" : "git.operationFailedGeneric");
  const dialog = (
    <ConfirmDialog
      open={Boolean(target || error || ownBusy)}
      title={title}
      message={
        target
          ? t(
              target.action === "delete"
                ? "git.manageDeleteConfirm"
                : "git.manageSource",
              { values: { branch: target.branch.name } },
            )
          : busy
            ? t("git.manageBusy")
            : ""
      }
      confirmLabel={t(target ? "common.confirm" : "common.close")}
      cancelLabel={target ? t("common.cancel") : undefined}
      isConfirming={ownBusy}
      variant={target?.action === "delete" ? "danger" : "default"}
      onConfirm={target ? confirm : () => setError(null)}
      onCancel={() => {
        if (!busy) {
          setTarget(null);
          setError(null);
        }
      }}
    >
      {target && target.action !== "delete" && (
        <input
          autoFocus
          aria-label={t("git.manageName")}
          placeholder={t("git.manageName")}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      )}
      {error && (
        <p role="alert" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
  return { menuItems, dialog, checkout, busy, sessionRunning };
}
