import { ipcRenderer } from "electron";
import type { DiffCommentSide, DiffReviewCommentRecord } from "../types";

export const diffCommentApi = {
  listDiffReviewComments: (
    directoryId: string,
    filePath: string,
  ): Promise<DiffReviewCommentRecord[]> =>
    ipcRenderer.invoke("diff-comments:list", directoryId, filePath),
  createDiffReviewComment: (
    directoryId: string,
    filePath: string,
    side: DiffCommentSide,
    lineNumber: number,
    lineContent: string,
    content: string,
  ): Promise<DiffReviewCommentRecord> =>
    ipcRenderer.invoke(
      "diff-comments:create",
      directoryId,
      filePath,
      side,
      lineNumber,
      lineContent,
      content,
    ),
  updateDiffReviewComment: (
    commentId: string,
    content: string,
  ): Promise<DiffReviewCommentRecord> =>
    ipcRenderer.invoke("diff-comments:update", commentId, content),
  deleteDiffReviewComment: (commentId: string): Promise<void> =>
    ipcRenderer.invoke("diff-comments:delete", commentId),
  deleteDiffReviewCommentsForFile: (
    directoryId: string,
    filePath: string,
  ): Promise<number> =>
    ipcRenderer.invoke("diff-comments:clear-file", directoryId, filePath),
};
