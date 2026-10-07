import { ipcRenderer } from "electron";
import type { FileReviewAnnotationRecord } from "../types";

export const fileReviewAnnotationApi = {
  listFileReviewAnnotations: (
    sourceKey: string,
    filePath: string,
  ): Promise<FileReviewAnnotationRecord[]> =>
    ipcRenderer.invoke("file-review-annotations:list", sourceKey, filePath),
  createFileReviewAnnotation: (
    sourceKey: string,
    filePath: string,
    anchorJson: string,
    content: string,
  ): Promise<FileReviewAnnotationRecord> =>
    ipcRenderer.invoke(
      "file-review-annotations:create",
      sourceKey,
      filePath,
      anchorJson,
      content,
    ),
  updateFileReviewAnnotation: (
    sourceKey: string,
    filePath: string,
    annotationId: string,
    content: string,
  ): Promise<FileReviewAnnotationRecord> =>
    ipcRenderer.invoke(
      "file-review-annotations:update",
      sourceKey,
      filePath,
      annotationId,
      content,
    ),
  deleteFileReviewAnnotation: (
    sourceKey: string,
    filePath: string,
    annotationId: string,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "file-review-annotations:delete",
      sourceKey,
      filePath,
      annotationId,
    ),
};
