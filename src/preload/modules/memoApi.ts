import { ipcRenderer } from "electron";
import type {
  MemoCountSummary,
  MemoPage,
  MemoRecord,
  MemoSortField,
  MemoStatus,
} from "../types";

export const memoApi = {
  listMemos: (
    directoryId: string,
    limit: number,
    offset: number,
    status?: MemoStatus,
    sortField?: MemoSortField,
    sortOrder?: "asc" | "desc",
    keyword?: string,
  ): Promise<MemoPage> =>
    ipcRenderer.invoke(
      "memos:list",
      directoryId,
      limit,
      offset,
      status,
      sortField,
      sortOrder,
      keyword,
    ),
  createMemo: (directoryId: string, content: string): Promise<MemoRecord> =>
    ipcRenderer.invoke("memos:create", directoryId, content),
  updateMemoContent: (memoId: string, content: string): Promise<MemoRecord> =>
    ipcRenderer.invoke("memos:update-content", memoId, content),
  updateMemoStatus: (memoId: string, status: MemoStatus): Promise<MemoRecord> =>
    ipcRenderer.invoke("memos:update-status", memoId, status),
  deleteMemo: (memoId: string): Promise<void> =>
    ipcRenderer.invoke("memos:delete", memoId),
  getMemoCountSummary: (directoryId: string): Promise<MemoCountSummary> =>
    ipcRenderer.invoke("memos:count-summary", directoryId),
};
