import { useSyncExternalStore } from "react";

import { parseCommunitySearch, type CommunityPluginEntry } from "./market";

export type CommunityStoreStatus = "idle" | "loading" | "ready" | "error";

export type CommunityStoreState = {
  status: CommunityStoreStatus;
  error: string | null;
  /** 最近一次已完成的检索关键词（输入框的实时值由组件自己维护）。 */
  query: string;
  entries: CommunityPluginEntry[];
  /** GitHub 报告的匹配仓库总数（可能大于本次返回的条目数）。 */
  total: number;
  /** 本轮是否因限流 / 网络故障沿用了缓存结果。 */
  limited: boolean;
  limitedReason: string;
  /** 最近一次成功检索的时间戳（秒，0 表示尚未成功）。 */
  updatedAt: number;
  /** 是否已经完成过一次检索（区分「尚未检索」与「没有结果」空态）。 */
  searched: boolean;
};

let state: CommunityStoreState = {
  status: "idle",
  error: null,
  query: "",
  entries: [],
  total: 0,
  limited: false,
  limitedReason: "",
  updatedAt: 0,
  searched: false,
};

const listeners = new Set<() => void>();
/** 检索串行化：GitHub 搜索接口限流严格，同时只跑一个请求。 */
let queue: Promise<void> = Promise.resolve();

const commit = (partial: Partial<CommunityStoreState>): void => {
  state = { ...state, ...partial };
  for (const listener of listeners) {
    listener();
  }
};

const load = async (query: string, forceRefresh: boolean): Promise<void> => {
  commit({
    status: state.searched ? "ready" : "loading",
    error: null,
    query,
  });
  try {
    const text = await window.snow.fetchPluginCommunity(query, forceRefresh);
    const result = parseCommunitySearch(text);
    commit({
      status: "ready",
      entries: result.items,
      total: result.total,
      limited: result.limited,
      limitedReason: result.reason,
      updatedAt: result.fetchedAt,
      searched: true,
      error: null,
    });
  } catch (error) {
    commit({
      status: "error",
      searched: true,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const communityStore = {
  getState(): CommunityStoreState {
    return state;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /**
   * 检索社区插件（`query` 追加在 GitHub 主题之后，可为空）。
   * 请求按调用顺序串行执行；调用方拿到的是本次检索完成后的 Promise。
   */
  search(query: string, forceRefresh = false): Promise<void> {
    const next = queue.then(() => load(query, forceRefresh));
    queue = next.catch(() => undefined);
    return next;
  },
  /** 首次进入社区标签页时自动检索一次（已检索过则复用现有结果）。 */
  ensureLoaded(): Promise<void> {
    if (state.searched) {
      return Promise.resolve();
    }
    return communityStore.search("");
  },
};

export const useCommunityStore = (): CommunityStoreState =>
  useSyncExternalStore(
    communityStore.subscribe,
    communityStore.getState,
    () => state,
  );
