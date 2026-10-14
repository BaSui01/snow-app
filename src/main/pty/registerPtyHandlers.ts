import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  claimPtyForWebContents,
  createPtySession,
  killPty,
  resizePty,
  writePtyInput,
  type PtySessionOptions,
} from "./ptyManager";

const normalizePtySessionOptions = (value: unknown): PtySessionOptions => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid PTY session options");
  }
  const obj = value as Record<string, unknown>;
  const cwd = typeof obj.cwd === "string" ? obj.cwd : process.cwd();
  const cols = typeof obj.cols === "number" ? obj.cols : 80;
  const rows = typeof obj.rows === "number" ? obj.rows : 24;
  const shellPath =
    typeof obj.shellPath === "string" ? obj.shellPath : undefined;
  const sessionId =
    typeof obj.sessionId === "string" && obj.sessionId.trim()
      ? obj.sessionId.trim()
      : undefined;
  return { cwd, cols, rows, shellPath, sessionId };
};

export const registerPtyHandlers = (): void => {
  ipcMain.handle(
    "pty:create",
    async (event: IpcMainInvokeEvent, options: unknown) => {
      const opts = normalizePtySessionOptions(options);
      return await createPtySession(event.sender, opts);
    },
  );

  ipcMain.handle(
    "pty:write",
    (_event: IpcMainInvokeEvent, id: unknown, data: unknown) => {
      if (typeof id !== "string" || typeof data !== "string") {
        throw new Error("Invalid PTY write arguments");
      }
      writePtyInput(id, data);
      return undefined;
    },
  );

  ipcMain.handle(
    "pty:resize",
    (_event: IpcMainInvokeEvent, id: unknown, cols: unknown, rows: unknown) => {
      if (
        typeof id !== "string" ||
        typeof cols !== "number" ||
        typeof rows !== "number"
      ) {
        throw new Error("Invalid PTY resize arguments");
      }
      resizePty(id, cols, rows);
      return undefined;
    },
  );

  ipcMain.handle("pty:kill", (_event: IpcMainInvokeEvent, id: unknown) => {
    if (typeof id !== "string") {
      throw new Error("Invalid PTY kill argument");
    }
    killPty(id);
    return undefined;
  });

  // 目标渲染进程接管已有会话（独立面板窗口 / 还原到主窗口）：转移输出通道与
  // 回收归属。返回 false 表示会话已不存在。
  ipcMain.handle(
    "pty:attach",
    (event: IpcMainInvokeEvent, id: unknown): boolean => {
      if (typeof id !== "string") {
        throw new Error("Invalid PTY attach argument");
      }
      return claimPtyForWebContents(id, event.sender);
    },
  );
};
