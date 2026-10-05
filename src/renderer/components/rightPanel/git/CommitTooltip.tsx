import { createPortal } from "react-dom";
import type { GitLogEntry, GitWorktreeInfo } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { getCommitWorktrees, parseRefs } from "./gitGraphRefs";

type CommitTooltipProps = {
  commit: GitLogEntry;
  worktrees: GitWorktreeInfo[];
  tooltipRef: React.RefObject<HTMLDivElement | null>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
};

export function CommitTooltip({
  commit,
  worktrees,
  tooltipRef,
  onMouseEnter,
  onMouseLeave,
}: CommitTooltipProps): React.JSX.Element {
  const { t } = useI18n();

  return createPortal(
    <div
      className="git-graph-tooltip"
      ref={tooltipRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span className="git-graph-tooltip-arrow" aria-hidden="true" />
      <div className="git-graph-tooltip-row">
        <span className="git-graph-tooltip-label">
          {t("git.graphTooltipHash")}
        </span>
        <span className="git-graph-tooltip-value git-graph-tooltip-mono">
          {commit.hash}
        </span>
      </div>
      <div className="git-graph-tooltip-row">
        <span className="git-graph-tooltip-label">
          {t("git.graphTooltipAuthor")}
        </span>
        <span className="git-graph-tooltip-value">
          {commit.author}
          {commit.email ? ` <${commit.email}>` : ""}
        </span>
      </div>
      <div className="git-graph-tooltip-row">
        <span className="git-graph-tooltip-label">
          {t("git.graphTooltipDate")}
        </span>
        <span className="git-graph-tooltip-value">{commit.date}</span>
      </div>
      {(commit.additions > 0 || commit.deletions > 0) && (
        <div className="git-graph-tooltip-row">
          <span className="git-graph-tooltip-label">
            {t("git.graphTooltipStats")}
          </span>
          <span className="git-graph-tooltip-value">
            <span className="git-graph-stats">
              {commit.additions > 0 && (
                <span className="git-graph-stats-add">+{commit.additions}</span>
              )}
              {commit.deletions > 0 && (
                <span className="git-graph-stats-del">-{commit.deletions}</span>
              )}
            </span>
          </span>
        </div>
      )}
      {commit.refs && (
        <div className="git-graph-tooltip-row">
          <span className="git-graph-tooltip-label">
            {t("git.graphTooltipRefs")}
          </span>
          <span className="git-graph-tooltip-value">
            {parseRefs(commit.refs)
              .map((ref) => ref.name)
              .join(", ")}
          </span>
        </div>
      )}
      {getCommitWorktrees(commit, parseRefs(commit.refs), worktrees).map(
        (worktree) => (
          <div
            className="git-graph-tooltip-row"
            key={`tooltip-worktree-${worktree.worktreeId}`}
          >
            <span className="git-graph-tooltip-label">
              {worktree.branchName ?? t("git.graphDetachedHead")}
            </span>
            <span className="git-graph-tooltip-value">
              {t("git.graphWorktreeTooltip", {
                values: {
                  path: worktree.worktreePath,
                  state: worktree.isDirty
                    ? t("git.worktreeDirty")
                    : t("git.graphWorktreeClean"),
                  validity: worktree.isValid
                    ? ""
                    : ` · ${t("git.graphWorktreeInvalid")}`,
                },
              })}
            </span>
          </div>
        ),
      )}
      {commit.parents.length > 0 && (
        <div className="git-graph-tooltip-row">
          <span className="git-graph-tooltip-label">
            {t("git.graphTooltipParents")}
          </span>
          <span className="git-graph-tooltip-value git-graph-tooltip-mono">
            {commit.parents.join(", ")}
          </span>
        </div>
      )}
      <div className="git-graph-tooltip-divider" />
      <div className="git-graph-tooltip-message-section">
        <div className="git-graph-tooltip-subject">{commit.message}</div>
        {commit.body && (
          <div className="git-graph-tooltip-body">{commit.body}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
