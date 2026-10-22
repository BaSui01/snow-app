import type { GitDiffResult, GitFileStatus } from "../../../../preload";
import type { OpenDiffTabCallback } from "../types";

/** 先以加载态打开差异 tab，再异步填充 diff；staged 决定是否取 --cached。 */
export const openGitFileDiff = (
  repoPath: string,
  file: GitFileStatus,
  staged: boolean,
  onOpenInTab: OpenDiffTabCallback,
): void => {
  onOpenInTab(file, null, true);
  window.snow
    .gitFileDiff(repoPath, file.path, staged)
    .then((result) => onOpenInTab(file, result, false))
    .catch((err: unknown) => {
      // 请求失败时给出可见错误，而不是退化成「没有可显示的变更」
      const failure: GitDiffResult = {
        content: "",
        isBinary: false,
        error: err instanceof Error ? err.message : String(err),
      };
      onOpenInTab(file, failure, false);
    });
};
