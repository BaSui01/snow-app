/**
 * 项目资源管理器的显示位置偏好：内嵌左侧面板（旧方案）或右侧面板 tab（新方案）。
 *
 * 偏好持久化到 localStorage，应用重启后复原；默认内嵌左侧面板。侧栏、右侧面板、
 * 顶栏 Plus 菜单与资源管理器自身都订阅该偏好，切换后立即在目标位置生效。
 */

export type ExplorerPlacement = "sidebar" | "right-panel";

const STORAGE_KEY = "snow.explorer.placement";
const DEFAULT_PLACEMENT: ExplorerPlacement = "sidebar";

const readStoredPlacement = (): ExplorerPlacement => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "right-panel"
      ? "right-panel"
      : DEFAULT_PLACEMENT;
  } catch {
    return DEFAULT_PLACEMENT;
  }
};

let placement: ExplorerPlacement = readStoredPlacement();
/** 最近一次展示的工作区目录：切换显示位置时保持同一个项目。 */
let lastDirectoryId = "";
const listeners = new Set<(next: ExplorerPlacement) => void>();

export const explorerPlacementStore = {
  get(): ExplorerPlacement {
    return placement;
  },
  getDirectoryId(): string {
    return lastDirectoryId;
  },
  rememberDirectoryId(directoryId: string): void {
    lastDirectoryId = directoryId;
  },
  set(next: ExplorerPlacement): void {
    if (next === placement) {
      return;
    }
    placement = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 持久化失败时仅本次会话生效。
    }
    for (const listener of listeners) {
      listener(next);
    }
  },
  subscribe(listener: (next: ExplorerPlacement) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
