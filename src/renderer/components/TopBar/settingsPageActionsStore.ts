import type { ComponentType } from "react";
import { useEffect, useSyncExternalStore } from "react";
import type { MainContentView } from "../mainContent/types";

/** 设置页发布给 TopBar 的按钮（原面板头部操作区）。 */
export type SettingsPageAction = {
  id: string;
  label: string;
  icon: ComponentType<{
    size?: number;
    strokeWidth?: number;
    className?: string;
  }>;
  /** 有值时按钮显示图标 + 文本（系统日志「清空日志」）。 */
  text?: string;
  disabled?: boolean;
  spinning?: boolean;
  danger?: boolean;
  onClick: () => void;
};

export type SettingsPageActionsSnapshot = {
  view: MainContentView;
  actions: SettingsPageAction[];
} | null;

let snapshot: SettingsPageActionsSnapshot = null;
const listeners = new Set<() => void>();
const EMPTY_ACTIONS: SettingsPageAction[] = [];

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): SettingsPageActionsSnapshot => snapshot;

export const settingsPageActionsStore = {
  set(next: SettingsPageActionsSnapshot): void {
    if (snapshot === next) return;
    if (
      snapshot &&
      next &&
      snapshot.view === next.view &&
      snapshot.actions === next.actions
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  },
};

export const useSettingsPageActions = (
  view: MainContentView,
): SettingsPageAction[] => {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return current && current.view === view ? current.actions : EMPTY_ACTIONS;
};

export const usePublishSettingsPageActions = (
  view: MainContentView,
  actions: SettingsPageAction[],
): void => {
  useEffect(() => {
    settingsPageActionsStore.set({ view, actions });
  });
  useEffect(
    () => () => {
      settingsPageActionsStore.set(null);
    },
    [view],
  );
};
