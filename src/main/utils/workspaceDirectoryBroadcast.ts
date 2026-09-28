import { BrowserWindow } from "electron";
import { safeSend } from "./safeSend";

/**
 * 广播项目列表变更：侧边栏等项目列表订阅方收到后重新拉取目录列表。
 * 除 IPC 处理器外，启动时自动激活默认项目等主进程内部变更同样需要广播，
 * 否则界面会停留在「没有激活项目」的中间态。
 */
export const broadcastWorkspaceDirectoryListChanged = (): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && window.webContents) {
      safeSend(window.webContents, "workspace-directory-list:changed");
    }
  }
};
