import { useCallback, useSyncExternalStore } from "react";

export type SidebarDisplayMode = "split" | "tree";

const STORAGE_KEY = "sidebar-display-mode";

const readStoredMode = (): SidebarDisplayMode => {
  try {
    return localStorage.getItem(STORAGE_KEY) === "tree" ? "tree" : "split";
  } catch {
    return "split";
  }
};

let currentMode: SidebarDisplayMode = readStoredMode();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): SidebarDisplayMode => currentMode;

export const setSidebarDisplayMode = (mode: SidebarDisplayMode): void => {
  if (currentMode === mode) {
    return;
  }
  currentMode = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {}
  for (const listener of listeners) {
    listener();
  }
};

export function useSidebarDisplayMode(): {
  mode: SidebarDisplayMode;
  toggleMode: () => void;
} {
  const mode = useSyncExternalStore(subscribe, getSnapshot);
  const toggleMode = useCallback((): void => {
    setSidebarDisplayMode(getSnapshot() === "tree" ? "split" : "tree");
  }, []);
  return { mode, toggleMode };
}
