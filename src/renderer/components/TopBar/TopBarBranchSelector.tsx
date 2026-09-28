import { GitBranch } from "lucide-react";
import { BranchSelector } from "../rightPanel/git/BranchSelector";
import { useGitStatus } from "../rightPanel/git/useGitStatus";

type TopBarBranchSelectorProps = {
  /** 当前工作区目录路径；为 git 仓库时展示分支切换下拉。 */
  repoPath?: string | null;
  /** 当前工作区目录 ID，用于加载独立工作树。 */
  directoryId?: string | null;
  /** 非 git 仓库（或状态未就绪）时回退展示的工作区名称。 */
  fallbackName?: string;
  /** 在指定路径打开终端。 */
  onOpenTerminal?: (cwd: string) => void;
};

export const TopBarBranchSelector = ({
  repoPath,
  directoryId,
  fallbackName,
  onOpenTerminal,
}: TopBarBranchSelectorProps): React.JSX.Element | null => {
  const { status, refresh } = useGitStatus(repoPath);

  if (repoPath && status?.isRepo) {
    return (
      <BranchSelector
        repoPath={repoPath}
        currentBranch={status.currentBranch}
        directoryId={directoryId}
        onOpenTerminal={onOpenTerminal}
        onBranchChanged={() => {
          void refresh();
        }}
      />
    );
  }

  if (!fallbackName) {
    return null;
  }

  return (
    <span className="top-bar-branch-label" title={fallbackName}>
      <GitBranch size={13} strokeWidth={1.8} />
      <span>{fallbackName}</span>
    </span>
  );
};
