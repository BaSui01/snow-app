import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AppLockState,
  AppLockTotpBinding,
  AppLockVerifyResult,
} from "../types";

const APP_LOCK_LOCKED_CHANNEL = "app-lock:locked";

export const appLockApi = {
  getAppLockState: (): Promise<AppLockState> =>
    ipcRenderer.invoke("app-lock:get-state"),
  setAppLockDelay: (delayMs: number): Promise<void> =>
    ipcRenderer.invoke("app-lock:set-delay", delayMs),
  beginAppLockTotpBinding: (): Promise<AppLockTotpBinding> =>
    ipcRenderer.invoke("app-lock:begin-totp-binding"),
  confirmAppLockTotpBinding: (
    secret: string,
    code: string,
    verification: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke(
      "app-lock:confirm-totp-binding",
      secret,
      code,
      verification,
    ),
  clearAppLockTotp: (code: string): Promise<AppLockVerifyResult> =>
    ipcRenderer.invoke("app-lock:clear-totp", code),
  enableAppLock: (pin: string): Promise<void> =>
    ipcRenderer.invoke("app-lock:enable", pin),
  changeAppLockPin: (
    verification: string,
    newPin: string,
  ): Promise<AppLockVerifyResult> =>
    ipcRenderer.invoke("app-lock:change-pin", verification, newPin),
  disableAppLock: (verification: string): Promise<AppLockVerifyResult> =>
    ipcRenderer.invoke("app-lock:disable", verification),
  verifyAppLockPin: (pin: string): Promise<AppLockVerifyResult> =>
    ipcRenderer.invoke("app-lock:verify-pin", pin),
  verifyAppLockTotp: (code: string): Promise<AppLockVerifyResult> =>
    ipcRenderer.invoke("app-lock:verify-totp", code),
  lockApp: (): Promise<void> => ipcRenderer.invoke("app-lock:lock"),
  unlockApp: (): Promise<void> => ipcRenderer.invoke("app-lock:unlock"),
  onAppLockLocked: (callback: () => void): (() => void) => {
    const handler = (_event: IpcRendererEvent): void => {
      callback();
    };

    ipcRenderer.on(APP_LOCK_LOCKED_CHANNEL, handler);

    return () => {
      ipcRenderer.removeListener(APP_LOCK_LOCKED_CHANNEL, handler);
    };
  },
};
