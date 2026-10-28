import { useSyncExternalStore } from "react";

/** 全屏遮罩（模态/确认框/锁屏）：出现时浮层必须让位。 */
const OVERLAY_SELECTOR = [
  ".app-modal-overlay",
  ".confirm-dialog-overlay",
  ".form-dialog-overlay",
  ".app-lock-overlay",
  ".ssh-wizard-overlay",
  ".storage-migration-overlay",
].join(",");

let open = false;
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

const measure = (): void => {
  const next = document.querySelector(OVERLAY_SELECTOR) !== null;
  if (next === open) {
    return;
  }
  open = next;
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (!observer) {
    // 遮罩均由条件渲染挂载/卸载，只需观察节点增删
    observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true, subtree: true });
    measure();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
    }
  };
};

const getSnapshot = (): boolean => open;

/** 是否有全屏遮罩打开（供悬浮浮层避让，避免盖在弹窗旁边）。 */
export const useOverlayOpen = (): boolean =>
  useSyncExternalStore(subscribe, getSnapshot);
