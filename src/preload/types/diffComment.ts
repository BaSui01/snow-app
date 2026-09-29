export type DiffCommentSide = "old" | "new";

export type DiffReviewCommentRecord = {
  id: string;
  commentId: string;
  directoryId: string;
  filePath: string;
  side: DiffCommentSide;
  lineNumber: number;
  lineContent: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};
