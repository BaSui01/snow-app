import { BrowserWindow, ipcMain } from "electron";
import type { NativeBridge } from "../../native/types";
import { lockAppNow, lockAppOnStartup } from "../../app/appLock";

const requireText = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value;
};

export const registerAppLockHandlers = (native: NativeBridge): void => {
  ipcMain.handle("app-lock:get-state", async () => {
    // 启动锁定必须先落库，保证渲染层首次读取就看到 locked 状态。
    await lockAppOnStartup();
    return native.getAppLockState();
  });
  ipcMain.handle("app-lock:set-delay", (_event, delayMs: unknown) =>
    native.setAppLockDelay(
      typeof delayMs === "number" && Number.isFinite(delayMs)
        ? Math.max(0, Math.round(delayMs))
        : 0,
    ),
  );
  ipcMain.handle("app-lock:begin-totp-binding", () =>
    native.beginAppLockTotpBinding(),
  );
  ipcMain.handle(
    "app-lock:confirm-totp-binding",
    (_event, secret: unknown, code: unknown, verification: unknown) =>
      native.confirmAppLockTotpBinding(
        requireText(secret, "Secret"),
        requireText(code, "Code"),
        typeof verification === "string" ? verification : "",
      ),
  );
  ipcMain.handle("app-lock:clear-totp", (_event, code: unknown) =>
    native.clearAppLockTotp(typeof code === "string" ? code : ""),
  );
  ipcMain.handle("app-lock:enable", (_event, pin: unknown) =>
    native.enableAppLock(requireText(pin, "PIN")),
  );
  ipcMain.handle(
    "app-lock:change-pin",
    (_event, verification: unknown, newPin: unknown) =>
      native.changeAppLockPin(
        requireText(verification, "Current PIN or code"),
        requireText(newPin, "New PIN"),
      ),
  );
  ipcMain.handle("app-lock:disable", (_event, verification: unknown) =>
    native.disableAppLock(requireText(verification, "PIN or code")),
  );
  ipcMain.handle("app-lock:verify-pin", (_event, pin: unknown) =>
    native.verifyAppLockPin(requireText(pin, "PIN")),
  );
  ipcMain.handle("app-lock:verify-totp", (_event, code: unknown) =>
    native.verifyAppLockTotp(requireText(code, "Code")),
  );
  ipcMain.handle("app-lock:lock", (event) =>
    lockAppNow(BrowserWindow.fromWebContents(event.sender)),
  );
  ipcMain.handle("app-lock:unlock", () => native.setAppLockLocked(false));
};
