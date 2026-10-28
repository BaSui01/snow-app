import { useSyncExternalStore } from "react";

import type { WorkspaceDirectoryRecord } from "../../../../preload";
import { buildDirectoryDisplayNames } from "./directoryDisplayName";

export type DirectoryInfo = {
  /** 目录显示名（同名项目带路径后缀区分） */
  name: string;
  record: WorkspaceDirectoryRecord;
};

let infos = new Map<string, DirectoryInfo>();
let pending: Promise<void> | null = null;
let stopListening: (() => void) | null = null;
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

/** 全量刷新目录信息；并发调用共用同一个请求。 */
const refresh = (): Promise<void> => {
  if (pending) {
    return pending;
  }
  pending = window.snow
    .listWorkspaceDirectories()
    .then((directories) => {
      const names = buildDirectoryDisplayNames(directories);
      infos = new Map(
        directories.map((record) => [
          record.directoryId,
          { name: names.get(record.directoryId) ?? record.name, record },
        ]),
      );
      notify();
    })
    .catch(() => {})
    .finally(() => {
      pending = null;
    });
  return pending;
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (!stopListening) {
    stopListening = window.snow.onWorkspaceDirectoryListChanged(() => {
      void refresh();
    });
    void refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopListening) {
      stopListening();
      stopListening = null;
    }
  };
};

const getSnapshot = (): Map<string, DirectoryInfo> => infos;

/** 目录显示名与记录（项目图标/配色复用目录列表）；目录列表变化时自动刷新。 */
export const useDirectoryInfo = (directoryId: string): DirectoryInfo | null =>
  useSyncExternalStore(subscribe, getSnapshot).get(directoryId) ?? null;
