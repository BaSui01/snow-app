import { BrowserWindow, ipcMain } from "electron";
import { showAppNotification } from "../../notification/notificationManager";
import { isAppNotificationOptions } from "../../../shared/notification";
import { getMainWindow } from "../../app/mainWindow";

export const registerNotificationHandlers = (): void => {
  ipcMain.handle("notification:show", (event, options: unknown) => {
    if (!isAppNotificationOptions(options)) {
      return;
    }

    // 来源 webContents 无法解析（窗口销毁边缘竞态）时回退到当前主窗口。
    const sourceWindow =
      BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
    if (!sourceWindow || sourceWindow.isDestroyed()) {
      return;
    }

    showAppNotification(options, sourceWindow);
  });
};
