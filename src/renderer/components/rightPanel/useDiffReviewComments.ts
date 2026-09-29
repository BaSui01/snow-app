import { useCallback, useEffect, useState } from "react";

import type {
  DiffCommentSide,
  DiffReviewCommentRecord,
} from "../../../preload";

type CreateCommentInput = {
  side: DiffCommentSide;
  lineNumber: number;
  lineContent: string;
  content: string;
};

type UseDiffReviewCommentsResult = {
  comments: DiffReviewCommentRecord[];
  createComment: (input: CreateCommentInput) => void;
  updateComment: (commentId: string, content: string) => void;
  deleteComment: (commentId: string) => void;
  clearComments: () => void;
};

/**
 * 右侧面板 diff 的行内评论数据源：按 项目（directoryId）+ 文件路径 加载，
 * 增删改后本地同步，不重新拉取。
 */
export const useDiffReviewComments = (
  directoryId: string | null | undefined,
  filePath: string | null,
): UseDiffReviewCommentsResult => {
  const [comments, setComments] = useState<DiffReviewCommentRecord[]>([]);

  useEffect(() => {
    setComments([]);
    if (!directoryId || !filePath) {
      return;
    }
    let cancelled = false;
    window.snow
      .listDiffReviewComments(directoryId, filePath)
      .then((records) => {
        if (!cancelled) {
          setComments(records);
        }
      })
      .catch((error) => {
        console.warn("Failed to load diff review comments:", error);
        if (!cancelled) {
          setComments([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [directoryId, filePath]);

  const createComment = useCallback(
    (input: CreateCommentInput): void => {
      if (!directoryId || !filePath) {
        return;
      }
      window.snow
        .createDiffReviewComment(
          directoryId,
          filePath,
          input.side,
          input.lineNumber,
          input.lineContent,
          input.content,
        )
        .then((record) => {
          setComments((prev) => [...prev, record]);
        })
        .catch((error) => {
          console.warn("Failed to create diff review comment:", error);
        });
    },
    [directoryId, filePath],
  );

  const updateComment = useCallback(
    (commentId: string, content: string): void => {
      window.snow
        .updateDiffReviewComment(commentId, content)
        .then((record) => {
          setComments((prev) =>
            prev.map((item) => (item.commentId === commentId ? record : item)),
          );
        })
        .catch((error) => {
          console.warn("Failed to update diff review comment:", error);
        });
    },
    [],
  );

  const deleteComment = useCallback((commentId: string): void => {
    window.snow
      .deleteDiffReviewComment(commentId)
      .then(() => {
        setComments((prev) =>
          prev.filter((item) => item.commentId !== commentId),
        );
      })
      .catch((error) => {
        console.warn("Failed to delete diff review comment:", error);
      });
  }, []);

  const clearComments = useCallback((): void => {
    if (!directoryId || !filePath) {
      return;
    }
    window.snow
      .deleteDiffReviewCommentsForFile(directoryId, filePath)
      .then(() => {
        setComments([]);
      })
      .catch((error) => {
        console.warn("Failed to clear diff review comments:", error);
      });
  }, [directoryId, filePath]);

  return {
    comments,
    createComment,
    updateComment,
    deleteComment,
    clearComments,
  };
};
