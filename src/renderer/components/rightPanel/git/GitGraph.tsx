import {
  Copy,
  Eye,
  EyeOff,
  FileText,
  FolderGit2,
  GitBranch,
  Hash,
  MessageSquareText,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GitBranch as GitBranchType,
  GitCommitFile,
  GitLogEntry,
  GitWorktreeInfo,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { ContextMenu, type ContextMenuItem } from "../../common/ContextMenu";
import type { OpenDiffTabCallback } from "../types";
import { CommitRow } from "./CommitRow";
import { CommitTooltip } from "./CommitTooltip";
import { WorktreeLegend } from "./WorktreeLegend";
import {
  LANE_WIDTH,
  computeGraph,
  reorderFirstParentFirst,
} from "./gitGraphLayout";
import {
  getCommitWorktrees,
  getWorktreeEdgeColors,
  parseRefs,
  type ParsedRef,
} from "./gitGraphRefs";
import {
  getWorktreeFolderName,
  isImageFile,
  isOtherWorktreePath,
  toGitFileStatus,
} from "./gitGraphUtils";
import { BRANCHES_CHANGED, useBranchManagement } from "./useBranchManagement";
import { useCommitHistory } from "./useCommitHistory";
import { useCommitTooltip } from "./useCommitTooltip";

type GitGraphProps = {
  repoPath: string;
  /** 当前分支名（来自 git status）：切换分支时提交图整体重载，因为图谱只
   *  包含当前分支可达的提交，增量合并无法移除旧分支独有的提交。 */
  branch?: string | null;
  /** Worktrees whose branches/HEADs should be identified in the graph. */
  worktrees?: GitWorktreeInfo[];
  /** Bump to force a full reload of the history from the first page. */
  refreshKey?: number;
  /** Opens a commit file's diff in a new right-panel tab. */
  onOpenInTab?: OpenDiffTabCallback;
};

export const GitGraph = ({
  repoPath,
  branch,
  worktrees = [],
  refreshKey,
  onOpenInTab,
}: GitGraphProps): React.JSX.Element => {
  const { t } = useI18n();
  const management = useBranchManagement(repoPath, () => {});
  const history = useCommitHistory(repoPath, branch, refreshKey);
  const {
    commits,
    isLoading,
    hasMore,
    error,
    selectedHash,
    commitFiles,
    isLoadingFiles,
    viewedCommitFile,
    selectCommitFile,
    containerRef,
    sentinelRef,
    handleRowClick,
    reload,
  } = history;
  const {
    hoveredCommit,
    tooltipRef,
    cancelHideTooltip,
    cancelShowTooltip,
    showTooltip,
    hideTooltip,
    scheduleHideTooltip,
  } = useCommitTooltip();

  // 分支与工作树映射表（branchName -> GitBranchType）
  const [branchMap, setBranchMap] = useState<Map<string, GitBranchType>>(
    new Map(),
  );

  // 分支徽章专属菜单
  const [branchContextMenu, setBranchContextMenu] = useState<{
    x: number;
    y: number;
    ref: ParsedRef;
  } | null>(null);

  // 提交行右键菜单：复制哈希 / 提交信息，以及展开收起提交详情。
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    commit: GitLogEntry;
  } | null>(null);
  // 提交内文件右键菜单：复制文件路径（双击文件在新标签页打开 Diff）。
  const [fileContextMenu, setFileContextMenu] = useState<{
    x: number;
    y: number;
    file: GitCommitFile;
  } | null>(null);

  // 轻量操作反馈（如 checkout 失败的错误原因），自动淡出
  const [actionError, setActionError] = useState<string | null>(null);
  const actionErrorTimerRef = useRef<number | null>(null);

  const showActionError = useCallback((msg: string) => {
    setActionError(msg);
    if (actionErrorTimerRef.current) {
      window.clearTimeout(actionErrorTimerRef.current);
    }
    actionErrorTimerRef.current = window.setTimeout(() => {
      setActionError(null);
    }, 4000);
  }, []);

  useEffect(() => {
    setBranchContextMenu(null);
    const changed = (event: Event): void => {
      if ((event as CustomEvent<string>).detail === repoPath) {
        void reload(() => cancelled);
        window.snow
          .gitBranches(repoPath)
          .then((items) => {
            if (!cancelled)
              setBranchMap(new Map(items.map((item) => [item.name, item])));
          })
          .catch((cause) => {
            if (!cancelled) showActionError(String(cause));
          });
      }
    };
    let cancelled = false;
    window.addEventListener(BRANCHES_CHANGED, changed);
    return () => {
      cancelled = true;
      window.removeEventListener(BRANCHES_CHANGED, changed);
    };
  }, [repoPath, reload, showActionError]);

  useEffect(() => {
    let cancelled = false;
    window.snow
      .gitBranches(repoPath)
      .then((branches) => {
        if (cancelled) return;
        const map = new Map<string, GitBranchType>();
        for (const b of branches) {
          map.set(b.name, b);
        }
        setBranchMap(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoPath, refreshKey]);

  const worktreeEdgeColors = useMemo(
    () => getWorktreeEdgeColors(commits, worktrees),
    [commits, worktrees],
  );
  const { rows, maxLanes } = useMemo(
    () => computeGraph(reorderFirstParentFirst(commits), worktreeEdgeColors),
    [commits, worktreeEdgeColors],
  );
  const graphWidth = Math.max(maxLanes * LANE_WIDTH, LANE_WIDTH);
  const matchedWorktreeIds = useMemo(() => {
    const matched = new Set<string>();
    for (const row of rows) {
      for (const worktree of getCommitWorktrees(
        row.commit,
        parseRefs(row.commit.refs),
        worktrees,
      )) {
        matched.add(worktree.worktreeId);
      }
    }
    return matched;
  }, [rows, worktrees]);

  const handleRowDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, commit: GitLogEntry) => {
      const tag = {
        hash: commit.hash,
        shortHash: commit.shortHash,
        author: commit.author,
        date: commit.date,
        message: commit.message,
        repoPath,
      };
      event.dataTransfer.setData("application/json", JSON.stringify(tag));
      event.dataTransfer.effectAllowed = "copy";
    },
    [repoPath],
  );

  const handleRowDragStartWithHide = (
    event: React.DragEvent<HTMLDivElement>,
    commit: GitLogEntry,
  ): void => {
    hideTooltip();
    handleRowDragStart(event, commit);
  };

  const handleRowActivate = (hash: string): void => {
    cancelShowTooltip();
    handleRowClick(hash);
  };

  const handleRowMenu = (
    event: React.MouseEvent,
    commit: GitLogEntry,
  ): void => {
    hideTooltip();
    setBranchContextMenu(null);
    setContextMenu({ x: event.clientX, y: event.clientY, commit });
  };

  const handleFileMenu = (
    event: React.MouseEvent,
    file: GitCommitFile,
  ): void => {
    hideTooltip();
    setFileContextMenu({ x: event.clientX, y: event.clientY, file });
  };

  const openBranchMenu = (ref: ParsedRef, x: number, y: number): void => {
    hideTooltip();
    setContextMenu(null);
    setFileContextMenu(null);
    setBranchContextMenu({ x, y, ref });
  };

  /** 分支徽章专属菜单：复制分支名 / 复制工作树路径 / 切换分支。 */
  const buildBranchMenuItems = (ref: ParsedRef): ContextMenuItem[] => {
    const branchInfo = branchMap.get(ref.name);
    const isCurrent = ref.isHead || branchInfo?.isCurrent;
    const worktreePath = branchInfo?.worktreePath;
    const isOtherWorktree = isOtherWorktreePath(worktreePath, repoPath);
    const worktreeFolder = worktreePath
      ? getWorktreeFolderName(worktreePath)
      : null;

    const items: ContextMenuItem[] = [
      {
        id: "copy-branch-name",
        label: t("git.copyBranchName", { defaultValue: "Copy Branch Name" }),
        icon: <Copy size={13} strokeWidth={1.8} />,
        onClick: () => {
          setBranchContextMenu(null);
          void window.snow.writeClipboardText(ref.name).catch(() => {});
        },
      },
    ];

    if (worktreePath) {
      items.push({
        id: "copy-worktree-path",
        label: t("git.copyWorktreePath", {
          defaultValue: "Copy Worktree Path",
        }),
        icon: <FolderGit2 size={13} strokeWidth={1.8} />,
        onClick: () => {
          setBranchContextMenu(null);
          void window.snow.writeClipboardText(worktreePath).catch(() => {});
        },
      });
      if (worktreeFolder) {
        items.push({
          id: "copy-worktree-name",
          label: t("git.copyWorktreeName", {
            defaultValue: "Copy Worktree Name",
          }),
          icon: <FileText size={13} strokeWidth={1.8} />,
          onClick: () => {
            setBranchContextMenu(null);
            void window.snow.writeClipboardText(worktreeFolder).catch(() => {});
          },
        });
      }
    }

    if (ref.kind === "local" && ref.name !== "HEAD") {
      items.push({
        id: "checkout-branch",
        separator: true,
        label: isCurrent
          ? t("git.currentBranch", { defaultValue: "Current Branch" })
          : isOtherWorktree
            ? `${t("git.worktreeCheckedOut", { defaultValue: "Checked out in Worktree" })}: ${worktreeFolder}`
            : t("git.checkoutBranch", { defaultValue: "Checkout Branch" }),
        icon: isOtherWorktree ? (
          <FolderGit2 size={13} strokeWidth={1.8} />
        ) : (
          <GitBranch size={13} strokeWidth={1.8} />
        ),
        disabled:
          isCurrent ||
          isOtherWorktree ||
          management.busy ||
          management.sessionRunning,
        onClick: () => {
          setBranchContextMenu(null);
          if (isCurrent || isOtherWorktree) return;
          management.checkout({
            name: ref.name,
            isCurrent: Boolean(isCurrent),
            isRemote: false,
            remoteName: null,
            worktreePath,
          });
        },
      });
    }

    if (
      (ref.kind === "local" || ref.kind === "remote") &&
      ref.name !== "HEAD"
    ) {
      items.push(
        ...management.menuItems(
          {
            name: ref.name,
            isCurrent: Boolean(isCurrent),
            isRemote: ref.kind === "remote",
            remoteName: branchInfo?.remoteName ?? null,
            worktreePath,
          },
          () => setBranchContextMenu(null),
        ),
      );
    }
    return items;
  };

  /** 提交行右键菜单：复制哈希 / 提交信息，以及展开收起提交详情。 */
  const buildCommitMenuItems = (commit: GitLogEntry): ContextMenuItem[] => {
    const isExpanded = selectedHash === commit.hash;
    const commitRefs = parseRefs(commit.refs);
    const localBranchRefs = commitRefs.filter(
      (r) => r.kind === "local" && r.name !== "HEAD",
    );

    const items: ContextMenuItem[] = [];

    // Open the same branch menu instead of expanding several long menus at once.
    for (const bRef of localBranchRefs.slice(0, 3)) {
      items.push({
        id: `manage-branch:${bRef.name}`,
        label: `${t("git.manageActions")}: ${bRef.name}`,
        icon: <GitBranch size={13} />,
        onClick: () => {
          const position = contextMenu;
          setContextMenu(null);
          if (position)
            setBranchContextMenu({ x: position.x, y: position.y, ref: bRef });
        },
      });
    }

    if (items.length > 0) {
      items[items.length - 1].separator = true;
    }

    items.push(
      {
        id: "copy-full-hash",
        label: t("git.copyFullHash", { defaultValue: "Copy Full Hash" }),
        icon: <Hash size={13} strokeWidth={1.8} />,
        onClick: () => {
          setContextMenu(null);
          void window.snow.writeClipboardText(commit.hash).catch(() => {
            // 剪贴板写入失败时静默忽略。
          });
        },
      },
      {
        id: "copy-short-hash",
        label: t("git.copyShortHash", { defaultValue: "Copy Short Hash" }),
        icon: <Copy size={13} strokeWidth={1.8} />,
        onClick: () => {
          setContextMenu(null);
          void window.snow.writeClipboardText(commit.shortHash).catch(() => {
            // 剪贴板写入失败时静默忽略。
          });
        },
      },
      {
        id: "copy-message",
        separator: true,
        label: t("git.copyCommitMessage", {
          defaultValue: "Copy Commit Message",
        }),
        icon: <MessageSquareText size={13} strokeWidth={1.8} />,
        onClick: () => {
          setContextMenu(null);
          const fullMessage = commit.body
            ? `${commit.message}\n\n${commit.body}`
            : commit.message;
          void window.snow.writeClipboardText(fullMessage).catch(() => {
            // 剪贴板写入失败时静默忽略。
          });
        },
      },
      {
        id: "toggle-detail",
        separator: true,
        label: isExpanded
          ? t("git.hideCommitDetails", {
              defaultValue: "Hide Commit Details",
            })
          : t("git.viewCommitDetails", {
              defaultValue: "View Commit Details",
            }),
        icon: isExpanded ? (
          <EyeOff size={13} strokeWidth={1.8} />
        ) : (
          <Eye size={13} strokeWidth={1.8} />
        ),
        onClick: () => {
          setContextMenu(null);
          handleRowClick(commit.hash);
        },
      },
    );

    return items;
  };

  /** 提交内文件右键菜单：复制文件路径。 */
  const buildCommitFileMenuItems = (file: GitCommitFile) => [
    {
      id: "copy-path",
      label: t("git.copyPath", { defaultValue: "Copy Path" }),
      icon: <FileText size={13} strokeWidth={1.8} />,
      onClick: () => {
        setFileContextMenu(null);
        void window.snow.writeClipboardText(file.path).catch(() => {
          // 剪贴板写入失败时静默忽略。
        });
      },
    },
  ];

  /** 在新标签页打开提交内文件 Diff：先以加载态打开标签，再异步填充结果。 */
  const openCommitFileDiffInTab = async (
    file: GitCommitFile,
    hash: string,
    parentHash: string | null,
  ): Promise<void> => {
    if (!repoPath || !onOpenInTab) {
      return;
    }
    const fileStatus = toGitFileStatus(file);
    onOpenInTab(fileStatus, null, true);
    try {
      if (isImageFile(file.path)) {
        // 图片文件：加载该提交版本与父提交版本直接渲染图片，
        // 请求文本 diff 会因二进制 --text 重试产生巨大乱码而卡死。
        const [newContent, oldContent] = await Promise.all([
          window.snow.gitFileContent(repoPath, file.path, hash),
          parentHash
            ? window.snow.gitFileContent(repoPath, file.path, parentHash)
            : Promise.resolve(null),
        ]);
        onOpenInTab(fileStatus, null, false, {
          old: oldContent,
          new: newContent,
        });
        return;
      }
      const result = await window.snow.gitCommitFileDiff(
        repoPath,
        hash,
        file.path,
      );
      onOpenInTab(fileStatus, result, false);
    } catch {
      onOpenInTab(fileStatus, null, false);
    }
  };

  const handleOpenFileDiff = (
    file: GitCommitFile,
    hash: string,
    parentHash: string | null,
  ): void => {
    void openCommitFileDiffInTab(file, hash, parentHash);
  };

  if (isLoading) {
    return (
      <div className="git-graph" ref={containerRef}>
        <div className="git-graph-loading">{t("git.graphLoading")}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="git-graph">
        <div className="git-graph-error">{t("git.graphError")}</div>
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="git-graph">
        <div className="git-graph-empty">{t("git.graphNoCommits")}</div>
      </div>
    );
  }

  return (
    <div className="git-graph" ref={containerRef}>
      {actionError && (
        <div
          className="git-graph-action-error"
          onClick={() => setActionError(null)}
          title={actionError}
        >
          <span>{actionError}</span>
        </div>
      )}
      <WorktreeLegend
        worktrees={worktrees}
        matchedWorktreeIds={matchedWorktreeIds}
      />
      {rows.map((row) => {
        return (
          <CommitRow
            key={row.commit.hash}
            row={row}
            graphWidth={graphWidth}
            isSelected={selectedHash === row.commit.hash}
            worktrees={worktrees}
            branchMap={branchMap}
            repoPath={repoPath}
            commitFiles={commitFiles}
            isLoadingFiles={isLoadingFiles}
            viewedCommitFile={viewedCommitFile}
            onActivate={handleRowActivate}
            onHoverStart={showTooltip}
            onHoverEnd={scheduleHideTooltip}
            onDragStart={handleRowDragStartWithHide}
            onRowMenu={handleRowMenu}
            onRefMenu={openBranchMenu}
            onFileMenu={handleFileMenu}
            onSelectFile={selectCommitFile}
            onOpenFileDiff={handleOpenFileDiff}
          />
        );
      })}
      {/* Sentinel is always rendered so the ref can bind; visibility is
          controlled by hasMore to avoid an invisible 1px div at the end. */}
      <div
        ref={sentinelRef}
        className="git-graph-sentinel"
        style={{ display: hasMore ? "block" : "none" }}
      />
      {hoveredCommit && (
        <CommitTooltip
          commit={hoveredCommit}
          worktrees={worktrees}
          tooltipRef={tooltipRef}
          onMouseEnter={cancelHideTooltip}
          onMouseLeave={scheduleHideTooltip}
        />
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildCommitMenuItems(contextMenu.commit)}
          onClose={() => setContextMenu(null)}
        />
      )}
      {fileContextMenu && (
        <ContextMenu
          x={fileContextMenu.x}
          y={fileContextMenu.y}
          items={buildCommitFileMenuItems(fileContextMenu.file)}
          onClose={() => setFileContextMenu(null)}
        />
      )}
      {management.dialog}
      {branchContextMenu && (
        <ContextMenu
          x={branchContextMenu.x}
          y={branchContextMenu.y}
          items={buildBranchMenuItems(branchContextMenu.ref)}
          onClose={() => setBranchContextMenu(null)}
        />
      )}
    </div>
  );
};
