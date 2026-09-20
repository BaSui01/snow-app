export type MemoStatus = "pending" | "done";

/** 列表排序依据：创建时间 / 更新时间（默认更新时间）。 */
export type MemoSortField = "created" | "updated";

export type MemoRecord = {
  id: string;
  memoId: string;
  directoryId: string;
  content: string;
  status: MemoStatus;
  createdAt: string;
  updatedAt: string;
};

export type MemoPage = {
  items: MemoRecord[];
  total: number;
  hasMore: boolean;
};

export type MemoCountSummary = {
  total: number;
  pending: number;
  done: number;
};
