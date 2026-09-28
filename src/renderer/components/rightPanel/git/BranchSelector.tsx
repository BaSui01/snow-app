import {
  GitBranch,
  ChevronDown,
  GitBranchPlus,
  RefreshCw,
  Copy,
  X,
  Loader2,
  FolderGit2,
  Search,
  Terminal,
  Trash2,
  Check,
  Folder,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GitBranch as GitBranchType,
  GitWorktreeInfo,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { ContextMenu, type ContextMenuItem } from "../../common/ContextMenu";
import { ConfirmDialog } from "../../common/ConfirmDialog";

type BranchSelectorProps = {
  repoPath: string;
  currentBranch: string;
  directoryId?: string | null;
  onBranchChanged: () => void;
  onOpenTerminal?: (cwd: string) => void;
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
  return branch
    .split("/")
    .every(
      (part) =>
        part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
    );
};

/** 提取末级工作树文件夹名称（如 chat, clone 等）。 */
const getFolderName = (p: string): string => {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
};

const normPath = (p: string | null | undefined): string => {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
};

export const BranchSelector = ({
  repoPath,
  currentBranch,
  directoryId,
  onBranchChanged,
  onOpenTerminal,
}: BranchSelectorProps): React.JSX.Element => {
  const { t } = useI18n();
  const [branches, setBranches] = useState<GitBranchType[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // 创建面板状态：null 不显示, 'branch' 新建分支, 'worktree' 新建工作树
  const [createMode, setCreateMode] = useState<"branch" | "worktree" | null>(
    null,
  );
  const [newBranchName, setNewBranchName] = useState("");
  const [worktreeBranchName, setWorktreeBranchName] = useState("");
  const [worktreeBaseRef, setWorktreeBaseRef] = useState("HEAD");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // 删除工作树确认
  const [removeWorktreeTarget, setRemoveWorktreeTarget] =
    useState<GitWorktreeInfo | null>(null);
  const [removingWorktree, setRemovingWorktree] = useState(false);

  // 剪贴板复制提示
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [branchItemContextMenu, setBranchItemContextMenu] = useState<{
    x: number;
    y: number;
    branch: GitBranchType;
  } | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const worktreeInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const isOtherWorktreePath = useCallback(
    (wtPath: string | null | undefined): boolean => {
      if (!wtPath) return false;
      const normWt = wtPath
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .toLowerCase();
      const normRepo = repoPath
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .toLowerCase();
      return normWt !== normRepo;
    },
    [repoPath],
  );

  /** 加载分支列表。 */
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

  /** 加载工作树列表。 */
  const loadWorktrees = useCallback(() => {
    if (!directoryId) {
      setWorktrees([]);
      return;
    }
    window.snow
      .gitListWorktrees(directoryId)
      .then(setWorktrees)
      .catch(() => {
        setWorktrees([]);
      });
  }, [directoryId]);

  useEffect(() => {
    loadWorktrees();
    window.addEventListener("snow:worktrees-changed", loadWorktrees);
    return () => {
      window.removeEventListener("snow:worktrees-changed", loadWorktrees);
    };
  }, [loadWorktrees]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    loadBranches();
    loadWorktrees();
  }, [isOpen, loadBranches, loadWorktrees]);

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
        setCreateMode(null);
        setNewBranchName("");
        setWorktreeBranchName("");
        setCreateError(null);
        setSearchQuery("");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  useEffect(() => {
    if (createMode === "branch") {
      branchInputRef.current?.focus();
    } else if (createMode === "worktree") {
      worktreeInputRef.current?.focus();
    }
  }, [createMode]);

  const handleCheckout = (branch: GitBranchType): void => {
    if (branch.name === currentBranch && !branch.isRemote) {
      setIsOpen(false);
      return;
    }

    if (isOtherWorktreePath(branch.worktreePath)) {
      setCreateError(
        t("git.branchCheckedOutInOtherWorktree", {
          values: {
            branch: branch.name,
            path: branch.worktreePath || "",
          },
          defaultValue: `分支 '${branch.name}' 已在工作树检出: ${branch.worktreePath}`,
        }),
      );
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
      ? branches.find(
          (item) => !item.isRemote && item.name === remoteBranchName,
        )
      : undefined;
    if (conflictingLocal && conflictingLocal.upstream !== target) {
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
      .then((res) => {
        if (res.success) {
          setIsOpen(false);
          onBranchChanged();
        } else {
          setCreateError(res.message || t("git.operationFailedGeneric"));
        }
      })
      .catch((cause: unknown) => {
        setCreateError(
          cause instanceof Error
            ? cause.message
            : t("git.operationFailedGeneric"),
        );
      });
  };

  /** 新建普通分支 */
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
          setCreateMode(null);
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

  /** 新建独立工作树 */
  const handleCreateWorktree = (): void => {
    if (!directoryId || !worktreeBranchName.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    window.snow
      .gitCreateWorktree(
        directoryId,
        worktreeBranchName.trim(),
        worktreeBaseRef.trim() || "HEAD",
      )
      .then((created) => {
        window.dispatchEvent(new Event("snow:worktrees-changed"));
        setWorktrees((items) => [
          ...items.filter((item) => item.worktreeId !== created.worktreeId),
          created,
        ]);
        setWorktreeBranchName("");
        setCreateMode(null);
        loadBranches();
        onBranchChanged();
      })
      .catch((cause: unknown) => {
        setCreateError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setCreating(false);
      });
  };

  /** 删除工作树 */
  const handleConfirmRemoveWorktree = (): void => {
    if (!directoryId || !removeWorktreeTarget || removingWorktree) return;
    setRemovingWorktree(true);
    setCreateError(null);
    window.snow
      .gitRemoveWorktree(directoryId, removeWorktreeTarget.worktreeId)
      .then(() => {
        setRemoveWorktreeTarget(null);
        window.dispatchEvent(new Event("snow:worktrees-changed"));
        loadWorktrees();
        loadBranches();
        onBranchChanged();
      })
      .catch((cause: unknown) => {
        const detail = cause instanceof Error ? cause.message : String(cause);
        setCreateError(
          /dirty|modified|uncommitted|未提交|修改/i.test(detail)
            ? t("git.worktreeRemoveDirty", {
                defaultValue: "工作树包含未提交的修改，无法安全删除",
              })
            : detail ||
                t("git.worktreeRemoveFailed", {
                  defaultValue: "删除工作树失败",
                }),
        );
      })
      .finally(() => {
        setRemovingWorktree(false);
      });
  };

  const handleCopyPath = (id: string, path: string): void => {
    void window.snow.writeClipboardText(path).then(() => {
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 1500);
    });
  };

  /** 单个分支项右键菜单 */
  const buildBranchItemMenuItems = (
    branch: GitBranchType,
  ): ContextMenuItem[] => {
    const isOtherWorktree = isOtherWorktreePath(branch.worktreePath);
    const worktreeFolder = branch.worktreePath
      ? getFolderName(branch.worktreePath)
      : null;

    const items: ContextMenuItem[] = [
      {
        id: "copy-branch-name",
        label: t("git.copyBranchName", { defaultValue: "复制分支名称" }),
        icon: <Copy size={13} strokeWidth={1.8} />,
        onClick: () => {
          setBranchItemContextMenu(null);
          void window.snow.writeClipboardText(branch.name).catch(() => {});
        },
      },
    ];

    if (branch.worktreePath) {
      items.push({
        id: "copy-worktree-path",
        label: t("git.copyWorktreePath", { defaultValue: "复制工作树路径" }),
        icon: <FolderGit2 size={13} strokeWidth={1.8} />,
        onClick: () => {
          setBranchItemContextMenu(null);
          void window.snow
            .writeClipboardText(branch.worktreePath!)
            .catch(() => {});
        },
      });
      if (onOpenTerminal) {
        items.push({
          id: "open-worktree-terminal",
          label: t("git.openTerminal", { defaultValue: "在此工作树打开终端" }),
          icon: <Terminal size={13} strokeWidth={1.8} />,
          onClick: () => {
            setBranchItemContextMenu(null);
            onOpenTerminal(branch.worktreePath!);
          },
        });
      }
    }

    if (!branch.isRemote) {
      items.push({
        id: "checkout-branch",
        separator: true,
        label: branch.isCurrent
          ? t("git.currentBranch", { defaultValue: "当前分支" })
          : isOtherWorktree
            ? `${t("git.worktreeCheckedOut", { defaultValue: "已在工作树检出" })}: ${worktreeFolder}`
            : t("git.checkoutBranch", { defaultValue: "切换至该分支" }),
        icon: isOtherWorktree ? (
          <FolderGit2 size={13} strokeWidth={1.8} />
        ) : (
          <GitBranch size={13} strokeWidth={1.8} />
        ),
        disabled: branch.isCurrent || isOtherWorktree,
        onClick: () => {
          setBranchItemContextMenu(null);
          handleCheckout(branch);
        },
      });
    }

    return items;
  };

  /** 外层按钮右键菜单 */
  const buildMenuItems = (): ContextMenuItem[] => [
    {
      id: "copy-branch",
      label: t("git.copyBranchName", { defaultValue: "复制分支名称" }),
      icon: <Copy size={13} strokeWidth={1.8} />,
      onClick: () => {
        setContextMenu(null);
        void window.snow.writeClipboardText(currentBranch).catch(() => {});
      },
    },
    {
      id: "create-branch",
      separator: true,
      label: t("git.createBranch", { defaultValue: "新建分支..." }),
      icon: <GitBranchPlus size={13} strokeWidth={1.8} />,
      onClick: () => {
        setContextMenu(null);
        setIsOpen(true);
        setCreateMode("branch");
      },
    },
    ...(directoryId
      ? [
          {
            id: "create-worktree",
            label: t("git.createWorktree", {
              defaultValue: "新建工作树 (Worktree)...",
            }),
            icon: <FolderGit2 size={13} strokeWidth={1.8} />,
            onClick: () => {
              setContextMenu(null);
              setIsOpen(true);
              setCreateMode("worktree");
            },
          },
        ]
      : []),
    {
      id: "refresh-branches",
      separator: true,
      label: t("git.refreshBranches", { defaultValue: "刷新分支与工作树" }),
      icon: <RefreshCw size={13} strokeWidth={1.8} />,
      onClick: () => {
        setContextMenu(null);
        loadBranches();
        loadWorktrees();
      },
    },
  ];

  const normalizedSearch = searchQuery.trim().toLowerCase();

  // 过滤工作树
  const filteredWorktrees = useMemo(() => {
    if (!normalizedSearch) return worktrees;
    return worktrees.filter(
      (wt) =>
        (wt.branchName &&
          wt.branchName.toLowerCase().includes(normalizedSearch)) ||
        getFolderName(wt.worktreePath)
          .toLowerCase()
          .includes(normalizedSearch) ||
        wt.worktreePath.toLowerCase().includes(normalizedSearch),
    );
  }, [worktrees, normalizedSearch]);

  // 本地分支
  const localBranches = useMemo(() => {
    return branches.filter(
      (b) =>
        !b.isRemote &&
        (!normalizedSearch || b.name.toLowerCase().includes(normalizedSearch)),
    );
  }, [branches, normalizedSearch]);

  // 远程分支
  const remoteBranches = useMemo(() => {
    return branches.filter(
      (b) =>
        b.isRemote &&
        (!normalizedSearch || b.name.toLowerCase().includes(normalizedSearch)),
    );
  }, [branches, normalizedSearch]);

  return (
    <div className="branch-selector">
      <button
        type="button"
        className="branch-selector-btn"
        onClick={() => setIsOpen(!isOpen)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setBranchItemContextMenu(null);
          setContextMenu({ x: e.clientX, y: e.clientY });
        }}
        title={`${currentBranch}${worktrees.length > 0 ? ` · ${worktrees.length} 个工作树` : ""}`}
      >
        <GitBranch
          size={13}
          strokeWidth={1.8}
          className="branch-selector-main-icon"
        />
        <span className="branch-selector-name">
          {currentBranch || t("git.unknownBranch")}
        </span>
        {worktrees.length > 0 && (
          <span
            className="branch-selector-wt-pill"
            title={t("git.worktreesCountTooltip", {
              values: { count: worktrees.length },
              defaultValue: `当前存在 ${worktrees.length} 个活跃工作树`,
            })}
          >
            <FolderGit2 size={11} strokeWidth={1.8} />
            <span>{worktrees.length}</span>
          </span>
        )}
        <ChevronDown
          size={11}
          strokeWidth={1.8}
          className="branch-selector-arrow"
        />
      </button>

      {isOpen && (
        <div className="branch-dropdown" ref={dropdownRef}>
          {/* 顶部搜索与快捷创建按钮组 */}
          <div className="branch-dropdown-header-bar">
            <div className="branch-dropdown-search">
              <Search size={12} className="branch-search-icon" />
              <input
                ref={searchInputRef}
                type="text"
                className="branch-search-input"
                placeholder={t("git.searchBranchesOrWorktrees", {
                  defaultValue: "搜索分支或工作树...",
                })}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && searchQuery) {
                    e.stopPropagation();
                    setSearchQuery("");
                  }
                }}
                spellCheck={false}
                autoComplete="off"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="branch-search-clear-btn"
                  onClick={() => setSearchQuery("")}
                  title={t("common.clear", { defaultValue: "清空" })}
                >
                  <X size={11} />
                </button>
              )}
            </div>

            <div className="branch-dropdown-header-actions">
              <button
                type="button"
                className={`branch-header-action-btn${createMode === "branch" ? " active" : ""}`}
                onClick={() => {
                  setCreateError(null);
                  setCreateMode((prev) =>
                    prev === "branch" ? null : "branch",
                  );
                }}
                title={t("git.createBranch", { defaultValue: "新建分支" })}
              >
                <GitBranchPlus size={12} strokeWidth={1.8} />
                <span>{t("git.branchShort", { defaultValue: "分支" })}</span>
              </button>
              {directoryId && (
                <button
                  type="button"
                  className={`branch-header-action-btn${createMode === "worktree" ? " active" : ""}`}
                  onClick={() => {
                    setCreateError(null);
                    setCreateMode((prev) =>
                      prev === "worktree" ? null : "worktree",
                    );
                  }}
                  title={t("git.createWorktree", {
                    defaultValue: "新建工作树",
                  })}
                >
                  <FolderGit2 size={12} strokeWidth={1.8} />
                  <span>
                    {t("git.worktreeShort", { defaultValue: "工作树" })}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* 错误提示条 */}
          {createError && (
            <div className="branch-create-error" role="alert">
              <span className="branch-create-error-text">{createError}</span>
              <button
                type="button"
                className="branch-create-error-close"
                onClick={() => setCreateError(null)}
              >
                <X size={11} />
              </button>
            </div>
          )}

          {/* 新建分支表单面板 */}
          {createMode === "branch" && (
            <div className="branch-inline-create-box">
              <div className="branch-inline-create-title">
                <GitBranchPlus size={13} strokeWidth={1.8} />
                <span>
                  {t("git.createBranchTitle", { defaultValue: "新建本地分支" })}
                </span>
              </div>
              <div className="branch-create-input-row">
                <input
                  ref={branchInputRef}
                  type="text"
                  className="branch-create-input"
                  placeholder={t("git.createBranchPlaceholder", {
                    defaultValue: "分支名称 (例如: feature/login)",
                  })}
                  value={newBranchName}
                  onChange={(e) => {
                    setNewBranchName(e.target.value);
                    setCreateError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreateBranch();
                    } else if (e.key === "Escape") {
                      setCreateMode(null);
                    }
                  }}
                  disabled={creating}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="branch-create-submit-btn"
                  onClick={handleCreateBranch}
                  disabled={creating || !newBranchName.trim()}
                >
                  {creating ? (
                    <Loader2 size={12} className="spin" />
                  ) : (
                    t("common.create", { defaultValue: "创建" })
                  )}
                </button>
              </div>
            </div>
          )}

          {/* 新建工作树表单面板 */}
          {createMode === "worktree" && directoryId && (
            <div className="branch-inline-create-box branch-inline-worktree-box">
              <div className="branch-inline-create-title">
                <FolderGit2 size={13} strokeWidth={1.8} />
                <span>
                  {t("git.createWorktreeTitle", {
                    defaultValue: "新建独立工作树 (Worktree)",
                  })}
                </span>
              </div>
              <div className="branch-worktree-form-grid">
                <div className="branch-worktree-form-field">
                  <label className="branch-form-label">
                    {t("git.worktreeBranchName", { defaultValue: "分支名称" })}
                  </label>
                  <input
                    ref={worktreeInputRef}
                    type="text"
                    className="branch-create-input"
                    placeholder="例如: feature/chat-redesign"
                    value={worktreeBranchName}
                    onChange={(e) => {
                      setWorktreeBranchName(e.target.value);
                      setCreateError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleCreateWorktree();
                      } else if (e.key === "Escape") {
                        setCreateMode(null);
                      }
                    }}
                    disabled={creating}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
                <div className="branch-worktree-form-field">
                  <label className="branch-form-label">
                    {t("git.worktreeBaseRef", { defaultValue: "基于基线" })}
                  </label>
                  <input
                    type="text"
                    className="branch-create-input"
                    placeholder="HEAD / main / 分支名"
                    value={worktreeBaseRef}
                    onChange={(e) => setWorktreeBaseRef(e.target.value)}
                    disabled={creating}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
              </div>
              <div className="branch-worktree-form-actions">
                <button
                  type="button"
                  className="branch-create-cancel-btn"
                  onClick={() => setCreateMode(null)}
                  disabled={creating}
                >
                  {t("common.cancel", { defaultValue: "取消" })}
                </button>
                <button
                  type="button"
                  className="branch-create-submit-btn"
                  onClick={handleCreateWorktree}
                  disabled={creating || !worktreeBranchName.trim()}
                >
                  {creating ? (
                    <>
                      <Loader2 size={12} className="spin" />
                      <span>
                        {t("git.creatingWorktree", {
                          defaultValue: "创建中...",
                        })}
                      </span>
                    </>
                  ) : (
                    t("git.createWorktreeSubmit", {
                      defaultValue: "创建并检出工作树",
                    })
                  )}
                </button>
              </div>
            </div>
          )}

          {/* 分支与工作树内容列表 */}
          <div className="branch-dropdown-content-scroll">
            {loading ? (
              <div className="branch-dropdown-loading">
                <Loader2 size={14} strokeWidth={1.8} className="spin" />
                <span>{t("git.loading")}</span>
              </div>
            ) : (
              <>
                {/* 1. 活跃工作树分组 (置顶) */}
                {filteredWorktrees.length > 0 && (
                  <div className="branch-dropdown-group branch-dropdown-group-worktrees">
                    <div className="branch-dropdown-label">
                      <FolderGit2
                        size={12}
                        strokeWidth={1.8}
                        className="branch-group-label-icon"
                      />
                      <span>
                        {t("git.worktreesTitle", {
                          defaultValue: "活跃工作树 (Worktrees)",
                        })}
                      </span>
                      <span className="branch-group-badge">
                        {filteredWorktrees.length}
                      </span>
                    </div>

                    {filteredWorktrees.map((wt) => {
                      const folderName = getFolderName(wt.worktreePath);
                      const isMain =
                        normPath(wt.worktreePath) ===
                        normPath(wt.repositoryPath);
                      const isCurrent =
                        normPath(wt.worktreePath) === normPath(repoPath) ||
                        (!isMain && wt.branchName === currentBranch);
                      const isCopied = copiedId === wt.worktreeId;

                      return (
                        <div
                          key={wt.worktreeId}
                          className={`branch-dropdown-item branch-dropdown-wt-item${isCurrent ? " active" : ""}`}
                          title={`${wt.worktreePath}${wt.isDirty ? " · 包含未提交修改" : ""}`}
                        >
                          <div className="branch-dropdown-item-left">
                            <span className="branch-wt-folder-badge">
                              <Folder size={11} strokeWidth={1.8} />
                              <span>{folderName}</span>
                            </span>
                            <span className="branch-wt-branch-badge">
                              <GitBranch size={11} strokeWidth={1.8} />
                              <span className="truncate max-w-[130px]">
                                {wt.branchName ||
                                  t("git.graphDetachedHead", {
                                    defaultValue: "游离 HEAD",
                                  })}
                              </span>
                            </span>
                            {isMain && (
                              <span
                                className="branch-badge branch-badge-main"
                                title={t("git.mainWorktreeTooltip", {
                                  defaultValue: "主工作区目录",
                                })}
                              >
                                {t("git.mainDirectory", {
                                  defaultValue: "主目录",
                                })}
                              </span>
                            )}
                            {wt.isDirty && (
                              <span
                                className="branch-wt-dirty-dot"
                                title={t("git.worktreeDirtyTooltip", {
                                  defaultValue: "该工作树包含未提交的修改",
                                })}
                              />
                            )}
                          </div>

                          <div
                            className="branch-dropdown-item-right branch-wt-actions"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="branch-wt-action-btn"
                              onClick={() =>
                                handleCopyPath(wt.worktreeId, wt.worktreePath)
                              }
                              title={t("git.copyWorktreePath", {
                                defaultValue: "复制完整路径",
                              })}
                            >
                              {isCopied ? (
                                <Check size={11} className="text-green-500" />
                              ) : (
                                <Copy size={11} />
                              )}
                            </button>
                            {onOpenTerminal && (
                              <button
                                type="button"
                                className="branch-wt-action-btn"
                                onClick={() => onOpenTerminal(wt.worktreePath)}
                                title={t("git.openTerminal", {
                                  defaultValue: "在此工作树打开终端",
                                })}
                              >
                                <Terminal size={11} />
                              </button>
                            )}
                            {!isMain && (
                              <button
                                type="button"
                                className="branch-wt-action-btn branch-wt-action-delete"
                                onClick={() => setRemoveWorktreeTarget(wt)}
                                title={t("git.removeWorktree", {
                                  defaultValue: "移除此工作树",
                                })}
                              >
                                <Trash2 size={11} />
                              </button>
                            )}
                            {isCurrent && (
                              <span className="branch-dropdown-item-check" />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* 2. 本地分支分组 */}
                {localBranches.length > 0 && (
                  <div className="branch-dropdown-group">
                    <div className="branch-dropdown-label">
                      <GitBranch
                        size={12}
                        strokeWidth={1.8}
                        className="branch-group-label-icon"
                      />
                      <span>{t("git.localBranches")}</span>
                      <span className="branch-group-badge">
                        {localBranches.length}
                      </span>
                    </div>

                    {localBranches.map((branch) => {
                      const isOtherWorktree = isOtherWorktreePath(
                        branch.worktreePath,
                      );
                      const worktreeFolder = branch.worktreePath
                        ? getFolderName(branch.worktreePath)
                        : null;
                      const isUpstreamTracking =
                        branch.upstream?.startsWith("upstream/");

                      return (
                        <button
                          key={branch.name}
                          type="button"
                          className={`branch-dropdown-item${branch.isCurrent ? " active" : ""}`}
                          onClick={() => handleCheckout(branch)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setContextMenu(null);
                            setBranchItemContextMenu({
                              x: e.clientX,
                              y: e.clientY,
                              branch,
                            });
                          }}
                          title={
                            isOtherWorktree
                              ? `${branch.name}\n${t("git.worktreeCheckedOut")}: ${branch.worktreePath}`
                              : branch.name
                          }
                        >
                          <div className="branch-dropdown-item-left">
                            <span className="branch-dropdown-item-name">
                              {branch.name}
                            </span>
                            {isOtherWorktree && (
                              <span
                                className="branch-dropdown-item-worktree-badge"
                                title={branch.worktreePath || ""}
                              >
                                <FolderGit2 size={11} strokeWidth={1.8} />
                                {worktreeFolder}
                              </span>
                            )}
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

                {/* 3. 远程分支分组 */}
                {remoteBranches.length > 0 && (
                  <div className="branch-dropdown-group">
                    <div className="branch-dropdown-label">
                      <span>{t("git.remoteBranches")}</span>
                      <span className="branch-group-badge">
                        {remoteBranches.length}
                      </span>
                    </div>
                    {remoteBranches.map((branch) => {
                      const isUpstream = branch.remoteName === "upstream";
                      return (
                        <button
                          key={branch.name}
                          type="button"
                          className={`branch-dropdown-item${branch.isCurrent ? " active" : ""}`}
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

                {branches.length === 0 && filteredWorktrees.length === 0 && (
                  <div className="branch-dropdown-empty">
                    {t("git.noBranches")}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* 删除工作树确认对话框 */}
      {removeWorktreeTarget && (
        <ConfirmDialog
          open={Boolean(removeWorktreeTarget)}
          title={t("git.removeWorktreeTitle", { defaultValue: "删除工作树" })}
          message={t("git.removeWorktreeConfirmMsg", {
            values: {
              path: removeWorktreeTarget.worktreePath,
              branch: removeWorktreeTarget.branchName || "",
            },
            defaultValue: `确定要移除工作树 ${getFolderName(removeWorktreeTarget.worktreePath)} 吗？本地磁盘目录和未暂存修改将被清理。`,
          })}
          confirmLabel={t("common.delete", { defaultValue: "删除" })}
          cancelLabel={t("common.cancel", { defaultValue: "取消" })}
          variant="danger"
          onConfirm={handleConfirmRemoveWorktree}
          onCancel={() => setRemoveWorktreeTarget(null)}
        />
      )}

      {/* 右键菜单 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems()}
          onClose={() => setContextMenu(null)}
        />
      )}
      {branchItemContextMenu && (
        <ContextMenu
          x={branchItemContextMenu.x}
          y={branchItemContextMenu.y}
          items={buildBranchItemMenuItems(branchItemContextMenu.branch)}
          onClose={() => setBranchItemContextMenu(null)}
        />
      )}
    </div>
  );
};
