import type { SnowRemoteState } from "../renderer/types/remoteControl";

/**
 * 各功能模块初始化时注入的最小运行时上下文。
 * refresh / getState 由 main.ts 的状态轮询循环提供，
 * invalidateTimeline 用于切换会话后强制重建消息区。
 */
export type AppContext = {
  refresh: (silent?: boolean) => Promise<void>;
  getState: () => SnowRemoteState | null;
  invalidateTimeline: () => void;
};
