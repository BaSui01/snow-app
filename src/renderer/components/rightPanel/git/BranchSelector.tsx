import {
  GitBranch,
  ChevronDown,
  GitBranchPlus,
  RefreshCw,
  Copy,
  X,
  Loader2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitBranch as GitBranchType } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { ContextMenu, type ContextMenuItem } from "../../common/ContextMenu";

type BranchSelectorProps = {
  repoPath: string;
  currentBranch: string;
  onBranchChanged: () => void;
};

const INVALID_REF_CHAR = /[\x00-\x20\x7f~^:?*\[\\]/;

const isValidBranchName = (branch: string): boolean => {
  if (
    branch.length === 0 ||
    branch.trim() !== branch ||
    branch === "@" ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("//") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    INVALID_REF_CHAR.test(branch)
  ) {
    return false;
  }
  return branch.split("/").every((part) =>
    part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
  );
};

export const BranchSelector = ({
  repoPath,
  currentBranch,
  onBranchChanged,
}: BranchSelectorProps): React.JSX.Element => {
  const { t } = useI18n();
  const [branches, setBranches] = useState<GitBranchType[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  /** 加载分支列表（打开下拉与右键刷新共用）。 */
  const loadBranches = useCallback(() => {
    setLoading(true);
    window.snow
      .gitBranches(repoPath)
      .then((result) => {
        setBranches(result);
      })
      .catch(() => {
        // Silent fail
      })
      .finally(() => {
        setLoading(false);
      });
  }, [repoPath]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    loadBranches();
  }, [isOpen, loadBranches]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent): void => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setShowCreate(false);
        setNewBranchName("");
        setCreateError(null);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  useEffect(() => {
    if (showCreate) {
      createInputRef.current?.focus();
    }
  }, [showCreate]);

  const handleCheckout = (branch: GitBranchType): void => {
    if (branch.name === currentBranch && !branch.isRemote) {
      setIsOpen(false);
      return;
    }

    const remoteName = branch.remoteName ?? "";
    const remotePrefix = remoteName ? `${remoteName}/` : "";
    const remoteBranchName =
      branch.isRemote && remotePrefix && branch.name.startsWith(remotePrefix)
        ? branch.name.slice(remotePrefix.length)
        : branch.name;
    const target = branch.isRemote
      ? remotePrefix
        ? `${remoteName}/${remoteBranchName}`
        : branch.name
      : branch.name;
    const conflictingLocal = branch.isRemote
      ? branches.find((item) => !item.isRemote && item.name === remoteBranchName)
      : undefined;
    if (
      conflictingLocal &&
      conflictingLocal.upstream !== target
    ) {
      setCreateError(
        t("git.branchTrackingConflict", {
          values: {
            branch: conflictingLocal.name,
            upstream: conflictingLocal.upstream || t("git.localOnlyBadge"),
            target,
          },
        }),
      );
      return;
    }

    const checkoutName = conflictingLocal?.name ?? target;
    window.snow
      .gitCheckout(repoPath, checkoutName)
      .then((result) => {
        if (!result.success) {
          setCreateError(result.message || t("git.checkoutBranchFailed"));
          return;
        }
        setIsOpen(false);
        onBranchChanged();
      })
      .catch((cause: unknown) => {
        setCreateError(cause instanceof Error ? cause.message : t("git.checkoutBranchFailed"));
      });
  };

  const handleCreateBranch = (): void => {
    const trimmed = newBranchName.trim();
    if (!isValidBranchName(newBranchName)) {
      setCreateError(t("git.createBranchInvalid"));
      return;
    }

    const exists = branches.some((b) => !b.isRemote && b.name === trimmed);
    if (exists) {
      setCreateError(t("git.createBranchExists"));
      return;
    }

    setCreating(true);
    setCreateError(null);
    window.snow
      .gitCreateBranch(repoPath, trimmed)
      .then((result) => {
        if (result.success) {
          setShowCreate(false);
          setNewBranchName("");
          setIsOpen(false);
          onBranchChanged();
        } else {
          setCreateError(result.message || t("git.createBranchFailed"));
        }
      })
      .catch(() => {
        setCreateError(t("git.createBranchFailed"));
      })
      .finally(() => {
        setCreating(false);
      });
  };

  const handleCreateInputKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleCreateBranch();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setShowCreate(false);
      setNewBranchName("");
      setCreateError(null);
    }
  };

  const handleToggleCreate = (): void => {
    setShowCreate(!showCreate);
    setNewBranchName("");
    setCreateError(null);
  };

  /** 右键菜单：复制分支名 / 新建分支 / 刷新分支列表。 */
  const buildMenuItems = (): ContextMenuItem[] => [
    {
      id: "copy-branch",
      label: t("git.copyBranchName", { defaultValue: "Copy Branch Name" }),
      icon: <Copy size={13} strokeWidth={1.8} />,
      onClick: () => {
        setContextMenu(null);
        void window.snow.writeClipboardText(currentBranch).catch(() => {
          // 剪贴板写入失败时静默忽略。
        });
      },
    },
    {
      id: "create-branch",
      separator: true,
      label: t("git.createBranch"),
      icon: <GitBranchPlus size={13} strokeWidth={1.8} />,
      onClick: () => {
        setContextMenu(null);
        // 打开下拉并进入创建分支表单。
        setIsOpen(true);
        setShowCreate(true);
      },
    },
    {
      id: "refresh-branches",
      label: t("git.refreshBranches", { defaultValue: "Refresh Branches" }),
      icon: <RefreshCw size={13} strokeWidth={1.8} />,
      onClick: () => {
        setContextMenu(null);
        loadBranches();
      },
    },
  ];

  const localBranches = branches.filter((b) => !b.isRemote);
  const remoteBranches = branches.filter((b) => b.isRemote);

  return (
    <div className="branch-selector">
      <button
        type="button"
        className="branch-selector-btn"
        onClick={() => setIsOpen(!isOpen)}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY });
        }}
        title={currentBranch}
      >
        <GitBranch size={14} strokeWidth={1.8} />
        <span className="branch-selector-name">
          {currentBranch || t("git.unknownBranch")}
        </span>
        <ChevronDown size={12} strokeWidth={1.8} />
      </button>
      {isOpen && (
        <div className="branch-dropdown" ref={dropdownRef}>
          <div className="branch-dropdown-create">
            {createError && (
              <div className="branch-create-error" role="alert">{createError}</div>
            )}
            {showCreate ? (
              <div className="branch-create-form">
                <div className="branch-create-input-row">
                  <input
                    ref={createInputRef}
                    type="text"
                    className="branch-create-input"
                    placeholder={t("git.createBranchPlaceholder")}
                    value={newBranchName}
                    onChange={(e) => {
                      setNewBranchName(e.target.value);
                      setCreateError(null);
                    }}
                    onKeyDown={handleCreateInputKeyDown}
                    disabled={creating}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="branch-create-cancel-btn"
                    onClick={handleToggleCreate}
                    disabled={creating}
                    title={t("git.discardCancelBtn")}
                  >
                    <X size={14} strokeWidth={1.8} />
                  </button>
                </div>
                <button
                  type="button"
                  className="branch-create-submit-btn"
                  onClick={handleCreateBranch}
                  disabled={creating || newBranchName.trim().length === 0}
                >
                  {creating ? t("git.loading") : t("git.createBranchSubmit")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="branch-create-toggle-btn"
                onClick={handleToggleCreate}
              >
                <GitBranchPlus size={14} strokeWidth={1.8} />
                <span>{t("git.createBranch")}</span>
              </button>
            )}
          </div>
          {loading ? (
            <div className="branch-dropdown-loading">
              <Loader2 size={14} strokeWidth={1.8} className="spin" />
              <span>{t("git.loading")}</span>
            </div>
          ) : (
            <>
              {localBranches.length > 0 && (
                <div className="branch-dropdown-group">
                  <div className="branch-dropdown-label">
                    {t("git.localBranches")}
                  </div>
                  {localBranches.map((branch) => {
                    const isUpstreamTracking =
                      branch.upstream?.startsWith("upstream/");
                    return (
                      <button
                        key={branch.name}
                        type="button"
                        className={`branch-dropdown-item${
                          branch.isCurrent ? " active" : ""
                        }`}
onClick={() => handleCheckout(branch)}
                      >
                        <div className="branch-dropdown-item-left">
                          <span className="branch-dropdown-item-name">
                            {branch.name}
                          </span>
                          {branch.upstream ? (
                            <span
                              className={`branch-dropdown-item-tracking${
                                isUpstreamTracking ? " is-upstream" : ""
                              }`}
                              title={
                                isUpstreamTracking
                                  ? `${t("git.upstreamRemoteTooltip")}: ${branch.upstream}`
                                  : branch.upstream
                              }
                            >
                              → {branch.upstream}
                            </span>
                          ) : (
                            <span
                              className="branch-badge branch-badge-local"
                              title={t("git.localOnlyBadge")}
                            >
                              {t("git.localOnlyBadge")}
                            </span>
                          )}
                        </div>
                        <div className="branch-dropdown-item-right">
                          {branch.isGone && (
                            <span
                              className="branch-badge branch-badge-gone"
                              title={t("git.goneBadge")}
                            >
                              {t("git.goneBadge")}
                            </span>
                          )}
                          {typeof branch.behind === "number" &&
                            branch.behind > 0 && (
                              <span
                                className="branch-badge branch-badge-behind"
                                title={t("git.behindTooltip", {
                                  values: { count: branch.behind },
                                })}
                              >
                                ↓{branch.behind}
                              </span>
                            )}
                          {typeof branch.ahead === "number" &&
                            branch.ahead > 0 && (
                              <span
                                className="branch-badge branch-badge-ahead"
                                title={t("git.aheadTooltip", {
                                  values: { count: branch.ahead },
                                })}
                              >
                                ↑{branch.ahead}
                              </span>
                            )}
                          {branch.isCurrent && (
                            <span className="branch-dropdown-item-check" />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              {remoteBranches.length > 0 && (
                <div className="branch-dropdown-group">
                  <div className="branch-dropdown-label">
                    {t("git.remoteBranches")}
                  </div>
                  {remoteBranches.map((branch) => {
                    const isUpstream = branch.remoteName === "upstream";
                    return (
                      <button
                        key={branch.name}
                        type="button"
                        className={`branch-dropdown-item${
                          branch.isCurrent ? " active" : ""
                        }`}
onClick={() => handleCheckout(branch)}
                      >
                        <div className="branch-dropdown-item-left">
                          <span className="branch-dropdown-item-name">
                            {branch.name}
                          </span>
                        </div>
                        <div className="branch-dropdown-item-right">
                          {isUpstream ? (
                            <span
                              className="branch-badge branch-badge-upstream"
                              title={t("git.upstreamRemoteTooltip")}
                            >
                              {t("git.upstreamBadge")}
                            </span>
                          ) : branch.remoteName ? (
                            <span className="branch-badge branch-badge-remote">
                              {branch.remoteName}
                            </span>
                          ) : null}
                          {branch.isCurrent && (
                            <span className="branch-dropdown-item-check" />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              {branches.length === 0 && (
                <div className="branch-dropdown-empty">
                  {t("git.noBranches")}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems()}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
