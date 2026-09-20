import type { BrowserWindow } from "electron";
import { native } from "../native/nativeBridge";
import { safeSend } from "../utils/safeSend";

const APP_LOCK_LOCKED_CHANNEL = "app-lock:locked";

let lockTimer: NodeJS.Timeout | null = null;

const cancelPendingLock = (): void => {
  if (lockTimer) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
};

export const lockAppNow = async (win: BrowserWindow | null): Promise<void> => {
  cancelPendingLock();
  await native.setAppLockLocked(true);
  if (win && !win.isDestroyed()) {
    safeSend(win.webContents, APP_LOCK_LOCKED_CHANNEL);
  }
};

const scheduleLock = (win: BrowserWindow, delayMs: number): void => {
  cancelPendingLock();
  if (delayMs <= 0) {
    void lockAppNow(win).catch(() => undefined);
    return;
  }
  lockTimer = setTimeout(() => {
    lockTimer = null;
    if (win.isDestroyed()) {
      return;
    }
    void lockAppNow(win).catch(() => undefined);
  }, delayMs);
};

const requestScheduledLock = (win: BrowserWindow): void => {
  void native
    .getAppLockState()
    .then((state) => {
      if (
        win.isDestroyed() ||
        !state.enabled ||
        !state.hasPin ||
        state.locked
      ) {
        cancelPendingLock();
        return;
      }
      scheduleLock(win, state.delayMs);
    })
    .catch(() => cancelPendingLock());
};

let startupLockPromise: Promise<void> | null = null;

const applyStartupLock = async (): Promise<void> => {
  const state = await native.getAppLockState();
  if (!state.enabled || !state.hasPin) {
    return;
  }
  await native.setAppLockLocked(true);
};

/**
 * 启动即锁定：应用锁启用时，每次启动都必须重新验证身份，
 * 避免重启（或渲染层重载）绕过 PIN 防护。幂等，可被首次状态读取复用。
 */
export const lockAppOnStartup = (): Promise<void> => {
  if (!startupLockPromise) {
    startupLockPromise = applyStartupLock().catch(() => undefined);
  }
  return startupLockPromise;
};

export const bindAppLockWatcher = (win: BrowserWindow): void => {
  const handleInactive = (): void => requestScheduledLock(win);
  const handleActive = (): void => cancelPendingLock();
  win.on("blur", handleInactive);
  win.on("hide", handleInactive);
  win.on("minimize", handleInactive);
  win.on("focus", handleActive);
  win.on("show", handleActive);
  win.on("restore", handleActive);
  win.on("closed", cancelPendingLock);
};
