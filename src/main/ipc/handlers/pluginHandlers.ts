import { BrowserWindow, dialog, ipcMain } from "electron";
import { extname } from "node:path";
import type { NativeBridge, PluginRecord } from "../../native/types";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const mimeTypeFor = (relativePath: string): string =>
  MIME_TYPES[extname(relativePath).toLowerCase()] ?? "application/octet-stream";

/**
 * 应用插件 IPC 通道。
 *
 * - 安装 / 启停 / 卸载 / 文件读取全部转发到 Rust 存储层（异步，不阻塞
 *   主进程）；渲染层拿到插件目录内的源码后自行完成插件运行时装配。
 * - 目录选择与资源编码（图标等二进制转 data URL）留在主进程，渲染层
 *   无法直接访问文件系统。
 */
export const registerPluginHandlers = (native: NativeBridge): void => {
  ipcMain.handle("plugins:list", (): Promise<PluginRecord[]> =>
    native.listPlugins(),
  );

  ipcMain.handle("plugins:get-directory", (): Promise<string> =>
    native.getPluginsDirectory(),
  );

  ipcMain.handle(
    "plugins:pick-directory",
    async (event, dialogTitle: unknown): Promise<string | null> => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select plugin directory";
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openDirectory"],
        filters: [],
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    },
  );

  ipcMain.handle(
    "plugins:install",
    (_event, sourceDir: unknown): Promise<PluginRecord> => {
      if (!isNonEmptyString(sourceDir)) {
        throw new Error("Plugin directory is required");
      }
      return native.installPlugin(sourceDir.trim());
    },
  );

  ipcMain.handle(
    "plugins:rescan",
    (_event, pluginId: unknown): Promise<PluginRecord> => {
      if (!isNonEmptyString(pluginId)) {
        throw new Error("Plugin id is required");
      }
      return native.rescanPlugin(pluginId.trim());
    },
  );

  ipcMain.handle(
    "plugins:set-enabled",
    (_event, pluginId: unknown, enabled: unknown): Promise<void> => {
      if (!isNonEmptyString(pluginId)) {
        throw new Error("Plugin id is required");
      }
      return native.setPluginEnabled(pluginId.trim(), Boolean(enabled));
    },
  );

  ipcMain.handle(
    "plugins:delete",
    (_event, pluginId: unknown, deleteFiles: unknown): Promise<void> => {
      if (!isNonEmptyString(pluginId)) {
        throw new Error("Plugin id is required");
      }
      return native.deletePlugin(pluginId.trim(), Boolean(deleteFiles));
    },
  );

  ipcMain.handle(
    "plugins:read-file",
    (_event, pluginId: unknown, relativePath: unknown): Promise<string> => {
      if (!isNonEmptyString(pluginId) || !isNonEmptyString(relativePath)) {
        throw new Error("Plugin id and file path are required");
      }
      return native.readPluginFile(pluginId.trim(), relativePath.trim());
    },
  );

  ipcMain.handle(
    "plugins:read-asset",
    async (
      _event,
      pluginId: unknown,
      relativePath: unknown,
    ): Promise<string | null> => {
      if (!isNonEmptyString(pluginId) || !isNonEmptyString(relativePath)) {
        return null;
      }
      try {
        const bytes = await native.readPluginAsset(
          pluginId.trim(),
          relativePath.trim(),
        );
        const base64 = Buffer.from(bytes).toString("base64");
        return `data:${mimeTypeFor(relativePath.trim())};base64,${base64}`;
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle("plugins:get-values", (_event, pluginId: unknown) => {
    if (!isNonEmptyString(pluginId)) {
      throw new Error("Plugin id is required");
    }
    return native.getPluginValues(pluginId.trim());
  });

  ipcMain.handle(
    "plugins:set-value",
    (_event, pluginId: unknown, key: unknown, value: unknown): Promise<void> => {
      if (!isNonEmptyString(pluginId) || !isNonEmptyString(key)) {
        throw new Error("Plugin id and key are required");
      }
      return native.setPluginValue(
        pluginId.trim(),
        key.trim(),
        typeof value === "string" ? value : JSON.stringify(value ?? null),
      );
    },
  );

  ipcMain.handle(
    "plugins:delete-value",
    (_event, pluginId: unknown, key: unknown): Promise<void> => {
      if (!isNonEmptyString(pluginId) || !isNonEmptyString(key)) {
        throw new Error("Plugin id and key are required");
      }
      return native.deletePluginValue(pluginId.trim(), key.trim());
    },
  );
};
