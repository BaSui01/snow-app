import { useSyncExternalStore } from "react";

/**
 * 团队协作面板发布给 TopBar 的状态快照：TeamPanel 是唯一生产者（挂载时写入、
 * 卸载时清空），TopBar 只作为消费者渲染标题、同步状态与身份操作，避免两处
 * 各自拉取团队数据（useTeamData 会启动 30s 轮询同步，双实例代价过高）。
 */
export type TeamTopBarSnapshot = {
  /** 团队名（当前项目名，作为 TopBar 标题）。 */
  teamName: string;
  /** 远端仓库地址，空串表示本地团队。 */
  remoteUrl: string;
  syncing: boolean;
  lastSyncAt: number | null;
  localAhead: number;
  localBehind: number;
  error: string | null;
  /** 当前用户的展示名与头像种子。 */
  meName: string;
  meSeed: string;
  sync: () => void;
  editIdentity: () => void;
};

let snapshot: TeamTopBarSnapshot | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): TeamTopBarSnapshot | null => snapshot;

export const teamTopBarStore = {
  set(next: TeamTopBarSnapshot | null): void {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  },
};

export const useTeamTopBarSnapshot = (): TeamTopBarSnapshot | null =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
