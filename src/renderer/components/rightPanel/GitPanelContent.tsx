import { useCallback, useRef, useState } from "react";
import { AlertTriangle, MoveVertical } from "lucide-react";

import { useI18n } from "../../i18n";
import type { GitDiffResult, GitFileStatus, GitStatusResult } from "./git";
import { GitControl, GitGraph, useGitRepos } from "./git";
import type { OpenDiffTabCallback } from "./types";
import type { RightPanelContentProps } from "./types";

const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;
const SPLIT_DEFAULT = 0.5;
/** 拖拽位移小于该值（px）时视为点击，用于切换提交图收起状态。 */
const DRAG_THRESHOLD = 4;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export function GitPanelContent({
  activeDirectory,
  onOpenInTab,
  onOpenFile,
  onOpenTerminal,
}: RightPanelContentProps & {
  onOpenInTab?: OpenDiffTabCallback;
  onOpenFile?: (filePath: string, fileName: string) => void;
  onOpenTerminal?: (cwd: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);
  const [splitRatio, setSplitRatio] = useState(SPLIT_DEFAULT);
  // 提交图区域是否收起：点击分隔条切换，收起时上方变更区占满，分隔条保留
  // 在原位供再次点击展开（展开后恢复收起前的高度比例）。
  const [graphCollapsed, setGraphCollapsed] = useState(false);
  // 提交图刷新键：手动刷新、提交 / 推送 / 拉取成功后自增，触发 GitGraph
  // 增量合并（历史被改写时它自行退回整体重载）。
  const [graphRefreshKey, setGraphRefreshKey] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const workspacePath = activeDirectory?.path ? activeDirectory.path : null;

  const { repos, selectedRepoPath, setSelectedRepoPath } =
    useGitRepos(workspacePath);

  const repoPath = selectedRepoPath;

  // 切换仓库后旧的 status 立即失效（其中的 currentBranch 属于上一个仓库）：
  // 在渲染期间同步清空（React 的「渲染期间调整 state」模式），避免旧分支名
  // 被当成新仓库的分支传给提交图；新 status 由 GitControl 重新回报。
  const [statusRepoPath, setStatusRepoPath] = useState(repoPath);
  if (statusRepoPath !== repoPath) {
    setStatusRepoPath(repoPath);
    setGitStatus(null);
  }

  /** 变更区/暂存区双击文件：在新的差异 tab 中打开（先加载态，再填充结果）。 */
  const handleFileSelect = useCallback(
    (file: GitFileStatus | null, section?: "staged" | "unstaged") => {
      if (!repoPath || !file || !onOpenInTab) {
        return;
      }
      // 双击来源优先：变更区 -> 工作区 diff；暂存区 -> `--cached` diff。
      // 同一文件同时存在于两个区域时，indexStatus 无法区分双击位置，
      // 必须以 section 为准。
      const isStaged = section === "staged";
      onOpenInTab(file, null, true);
      window.snow
        .gitFileDiff(repoPath, file.path, isStaged)
        .then((result) => onOpenInTab(file, result, false))
        .catch((err: unknown) => {
          // 请求失败（IPC/napi 抛错）时给出可见的错误提示，而不是静默
          // 退化成「没有可显示的变更」。
          const failure: GitDiffResult = {
            content: "",
            isBinary: false,
            error: err instanceof Error ? err.message : String(err),
          };
          onOpenInTab(file, failure, false);
        });
    },
    [repoPath, onOpenInTab],
  );

  /** 历史可能已变化（手动刷新 / 提交 / 推送 / 拉取成功）：触发提交图刷新。 */
  const handleHistoryRefresh = useCallback(() => {
    setGraphRefreshKey((key) => key + 1);
  }, []);

  // 分隔条同时承担「拖拽调整高度」与「点击收起/展开提交图」：位移超过阈值
  // 才算拖拽，否则抬起指针时切换收起状态。
  const startSplitResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const startY = event.clientY;
      const containerHeight = container.clientHeight;
      // 收起状态下拖动：从 0 开始展开，提交图跟着指针长出来。
      const wasCollapsed = graphCollapsed;
      const startRatio = wasCollapsed ? 0 : splitRatio;
      let moved = false;

      const handlePointerMove = (pointerEvent: PointerEvent): void => {
        const deltaY = pointerEvent.clientY - startY;
        if (!moved) {
          if (Math.abs(deltaY) < DRAG_THRESHOLD) {
            return;
          }
          moved = true;
          if (wasCollapsed) {
            setGraphCollapsed(false);
          }
        }
        const newRatio = startRatio + deltaY / containerHeight;
        setSplitRatio(clamp(newRatio, SPLIT_MIN, SPLIT_MAX));
      };

      const cleanup = (): void => {
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerUp);
        document.removeEventListener("pointercancel", cleanup);
        document.body.classList.remove("is-git-pane-resizing");
      };

      const handlePointerUp = (): void => {
        cleanup();
        if (!moved) {
          setGraphCollapsed((prev) => !prev);
        }
      };

      document.body.classList.add("is-git-pane-resizing");
      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
      document.addEventListener("pointercancel", cleanup);
    },
    [splitRatio, graphCollapsed],
  );

  return (
    <div className="git-panel-container" ref={containerRef}>
      <div
        className="git-panel-changes"
        style={{
          flexGrow: graphCollapsed ? 1 : splitRatio,
          flexBasis: 0,
          flexShrink: 0,
        }}
      >
        {gitStatus?.statusLimitHit ? (
          <div className="git-status-limit-hint">
            <AlertTriangle size={13} strokeWidth={1.9} />
            <span>
              {t("git.statusLimitHit", {
                defaultValue:
                  "Too many changes to display, only part of them are shown.",
              })}
            </span>
          </div>
        ) : null}
        <GitControl
          repoPath={repoPath}
          repos={repos}
          onRepoSelect={setSelectedRepoPath}
          onFileSelect={handleFileSelect}
          onStatusChange={setGitStatus}
          onOpenFile={onOpenFile}
          onOpenTerminal={onOpenTerminal}
          onHistoryRefresh={handleHistoryRefresh}
        />
      </div>

      <div
        className="h-resizer"
        role="separator"
        aria-label={t("rightPanel.resizeChangesAndGraph")}
        aria-orientation="horizontal"
        aria-expanded={!graphCollapsed}
        tabIndex={0}
        title={
          graphCollapsed
            ? t("rightPanel.expandCommitGraph")
            : t("rightPanel.collapseCommitGraph")
        }
        onPointerDown={startSplitResize}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setGraphCollapsed((prev) => !prev);
          }
        }}
      >
        <MoveVertical className="h-resizer-icon" size={12} />
      </div>

      <div
        className="git-panel-graph"
        style={{
          flexGrow: graphCollapsed ? 0 : 1 - splitRatio,
          flexBasis: 0,
          flexShrink: 0,
        }}
      >
        {repoPath ? (
          <GitGraph
            repoPath={repoPath}
            branch={gitStatus?.currentBranch ?? null}
            refreshKey={graphRefreshKey}
          />
        ) : (
          <div className="git-graph-empty">
            {t("rightPanel.noRepositorySelected")}
          </div>
        )}
      </div>
    </div>
  );
}
