import { useSyncExternalStore } from "react";

import { parseMarketRegistry, type MarketPluginEntry } from "./market";

export type MarketStoreStatus = "idle" | "loading" | "ready" | "error";

export type MarketStoreState = {
  status: MarketStoreStatus;
  error: string | null;
  entries: MarketPluginEntry[];
  updatedAt: string;
  appVersion: string;
};

let state: MarketStoreState = {
  status: "idle",
  error: null,
  entries: [],
  updatedAt: "",
  appVersion: "",
};

const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

const commit = (partial: Partial<MarketStoreState>): void => {
  state = { ...state, ...partial };
  for (const listener of listeners) {
    listener();
  }
};

const load = async (forceRefresh: boolean): Promise<void> => {
  commit({
    status: state.status === "ready" ? "ready" : "loading",
    error: null,
  });
  try {
    const [text, appVersion] = await Promise.all([
      window.snow.fetchPluginRegistry(forceRefresh),
      state.appVersion
        ? Promise.resolve(state.appVersion)
        : window.snow.getAppVersion().catch(() => ""),
    ]);
    const registry = parseMarketRegistry(text);
    commit({
      status: "ready",
      entries: registry.plugins,
      updatedAt: registry.updatedAt,
      appVersion,
      error: null,
    });
  } catch (error) {
    commit({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const marketStore = {
  getState(): MarketStoreState {
    return state;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** 首次需要市场数据时拉取索引（并发调用共享同一次请求）。 */
  ensureLoaded(): Promise<void> {
    if (state.status === "ready") {
      return Promise.resolve();
    }
    if (!inflight) {
      inflight = load(false).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  },
  /** 强制刷新市场索引（缓存策略由 Rust 侧决定）。 */
  refresh(): Promise<void> {
    if (!inflight) {
      inflight = load(true).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  },
};

export const useMarketStore = (): MarketStoreState =>
  useSyncExternalStore(
    marketStore.subscribe,
    marketStore.getState,
    () => state,
  );

/** 按 id 与类型查找市场条目（已安装列表匹配更新用）。 */
export const findMarketEntry = (
  entries: MarketPluginEntry[],
  id: string,
  kind: MarketPluginEntry["kind"],
): MarketPluginEntry | null =>
  entries.find((entry) => entry.id === id && entry.kind === kind) ?? null;
