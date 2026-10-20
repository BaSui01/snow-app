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
  deleteMemos: (memoIds: string[]): Promise<number> =>
    ipcRenderer.invoke("memos:delete-many", memoIds),
  getMemoCountSummary: (directoryId: string): Promise<MemoCountSummary> =>
    ipcRenderer.invoke("memos:count-summary", directoryId),
  /** AI 经 config memos 作用域改库后由主进程广播，参数为本次删除的 memoId。 */
  onMemosChanged: (callback: (deletedIds: string[]) => void): (() => void) => {
    const handler = (_event: unknown, deletedIds: unknown): void => {
      callback(
        Array.isArray(deletedIds)
          ? deletedIds.filter((id): id is string => typeof id === "string")
          : [],
      );
    };

    ipcRenderer.on("memos:changed", handler);

    return () => {
      ipcRenderer.removeListener("memos:changed", handler);
    };
  },
};
