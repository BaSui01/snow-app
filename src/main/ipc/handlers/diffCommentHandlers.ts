import { ipcMain } from "electron";
import type { NativeBridge } from "../../native/types";

const requireNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
};

const requireText = (value: unknown, label: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
};

const requireSide = (value: unknown): string => {
  if (value !== "old" && value !== "new") {
    throw new Error("Diff comment side must be 'old' or 'new'");
  }
  return value;
};

const requireLineNumber = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new Error("Diff comment line number must be a positive number");
  }
  return Math.floor(value);
};

const requireCommentContent = (value: unknown): string => {
  const content = requireText(value, "Diff comment content").trim();
  if (!content) {
    throw new Error("Diff comment content is required");
  }
  return content;
};

export const registerDiffCommentHandlers = (native: NativeBridge): void => {
  ipcMain.handle(
    "diff-comments:list",
    (_event, directoryId: unknown, filePath: unknown) => {
      return native.listDiffReviewComments(
        requireNonEmptyString(directoryId, "Directory ID"),
        requireNonEmptyString(filePath, "File path"),
      );
    },
  );

  ipcMain.handle(
    "diff-comments:create",
    (
      _event,
      directoryId: unknown,
      filePath: unknown,
      side: unknown,
      lineNumber: unknown,
      lineContent: unknown,
      content: unknown,
    ) => {
      return native.createDiffReviewComment(
        requireNonEmptyString(directoryId, "Directory ID"),
        requireNonEmptyString(filePath, "File path"),
        requireSide(side),
        requireLineNumber(lineNumber),
        requireText(lineContent, "Line content"),
        requireCommentContent(content),
      );
    },
  );

  ipcMain.handle(
    "diff-comments:update",
    (_event, commentId: unknown, content: unknown) => {
      return native.updateDiffReviewComment(
        requireNonEmptyString(commentId, "Comment ID"),
        requireCommentContent(content),
      );
    },
  );

  ipcMain.handle("diff-comments:delete", (_event, commentId: unknown) => {
    return native.deleteDiffReviewComment(
      requireNonEmptyString(commentId, "Comment ID"),
    );
  });

  ipcMain.handle(
    "diff-comments:clear-file",
    (_event, directoryId: unknown, filePath: unknown) => {
      return native.deleteDiffReviewCommentsForFile(
        requireNonEmptyString(directoryId, "Directory ID"),
        requireNonEmptyString(filePath, "File path"),
      );
    },
  );
};
