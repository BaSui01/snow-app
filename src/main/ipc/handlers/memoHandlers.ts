import { ipcMain } from "electron";
import type { NativeBridge } from "../../native/types";

const normalizeMemoStatus = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" || trimmed === "all") return undefined;
  if (trimmed === "pending" || trimmed === "done") return trimmed;
  return undefined;
};

/** 排序依据白名单：created / updated，其余（含空值）交给 Rust 侧默认。 */
const normalizeMemoSortField = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "created" || trimmed === "updated") return trimmed;
  return undefined;
};

const normalizeMemoSortOrder = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  return value.trim().toLowerCase() === "asc" ? "asc" : "desc";
};

/** 关键词：空白串归一化为 undefined（napi Option 只接受 undefined，不接受 null）。 */
const normalizeMemoKeyword = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const requireMemoId = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Memo ID is required");
  }
  return value.trim();
};

const requireMemoContent = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("Memo content must be a string");
  }
  return value;
};

const requireDirectoryId = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Directory ID is required for memos");
  }
  return value.trim();
};

export const registerMemoHandlers = (native: NativeBridge): void => {
  ipcMain.handle(
    "memos:list",
    (
      _event,
      directoryId: unknown,
      limit: unknown,
      offset: unknown,
      status: unknown,
      sortField: unknown,
      sortOrder: unknown,
      keyword: unknown,
    ) => {
      const safeLimit =
        typeof limit === "number" && limit > 0 ? Math.floor(limit) : 20;
      const safeOffset =
        typeof offset === "number" && offset > 0 ? Math.floor(offset) : 0;
      return native.listMemos(
        requireDirectoryId(directoryId),
        safeLimit,
        safeOffset,
        normalizeMemoStatus(status),
        normalizeMemoSortField(sortField),
        normalizeMemoSortOrder(sortOrder),
        normalizeMemoKeyword(keyword),
      );
    },
  );

  ipcMain.handle(
    "memos:create",
    (_event, directoryId: unknown, content: unknown) => {
      return native.createMemo(
        requireDirectoryId(directoryId),
        requireMemoContent(content),
      );
    },
  );

  ipcMain.handle(
    "memos:update-content",
    (_event, memoId: unknown, content: unknown) => {
      return native.updateMemoContent(
        requireMemoId(memoId),
        requireMemoContent(content),
      );
    },
  );

  ipcMain.handle(
    "memos:update-status",
    (_event, memoId: unknown, status: unknown) => {
      const normalizedStatus = normalizeMemoStatus(status);
      if (!normalizedStatus) {
        throw new Error("Memo status must be 'pending' or 'done'");
      }
      return native.updateMemoStatus(requireMemoId(memoId), normalizedStatus);
    },
  );

  ipcMain.handle("memos:delete", (_event, memoId: unknown) => {
    return native.deleteMemo(requireMemoId(memoId));
  });

  ipcMain.handle("memos:count-summary", (_event, directoryId: unknown) => {
    return native.getMemoCountSummary(requireDirectoryId(directoryId));
  });
};
