import { BrowserWindow, dialog, ipcMain, net } from "electron";
import { extname } from "node:path";
import type { NativeBridge, PluginRecord } from "../../native/types";

const PLUGIN_HTTP_DEFAULT_TIMEOUT_MS = 30000;
const PLUGIN_HTTP_MAX_TIMEOUT_MS = 120000;
const PLUGIN_HTTP_MAX_BYTES = 5 * 1024 * 1024;
const PLUGIN_HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

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
    (
      _event,
      pluginId: unknown,
      key: unknown,
      value: unknown,
    ): Promise<void> => {
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

  ipcMain.handle(
    "plugins:http-request",
    async (
      _event,
      payload: unknown,
    ): Promise<{
      ok: boolean;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
      url: string;
      error: string | null;
    }> => {
      if (payload === null || typeof payload !== "object") {
        throw new Error("Invalid plugin http request payload");
      }
      const { url, method, headers, body, timeoutMs } = payload as {
        url?: unknown;
        method?: unknown;
        headers?: unknown;
        body?: unknown;
        timeoutMs?: unknown;
      };
      if (!isNonEmptyString(url) || !/^https?:\/\//i.test(url)) {
        throw new Error("Plugin http request url must be http(s)");
      }
      const requestMethod = (
        isNonEmptyString(method) ? method : "GET"
      ).toUpperCase();
      if (!PLUGIN_HTTP_METHODS.has(requestMethod)) {
        throw new Error(`Unsupported http method '${requestMethod}'`);
      }
      const timeout =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
          ? Math.min(
              Math.max(Math.trunc(timeoutMs), 1000),
              PLUGIN_HTTP_MAX_TIMEOUT_MS,
            )
          : PLUGIN_HTTP_DEFAULT_TIMEOUT_MS;
      try {
        const response = await net.fetch(url, {
          method: requestMethod,
          headers:
            headers !== null && typeof headers === "object"
              ? (headers as Record<string, string>)
              : undefined,
          body:
            isNonEmptyString(body) &&
            requestMethod !== "GET" &&
            requestMethod !== "HEAD"
              ? body
              : undefined,
          redirect: "follow",
          credentials: "omit",
          signal: AbortSignal.timeout(timeout),
        });
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        const declaredLength = Number(
          response.headers.get("content-length") ?? 0,
        );
        if (declaredLength > PLUGIN_HTTP_MAX_BYTES) {
          return {
            ok: false,
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: "",
            url: response.url,
            error: "Response body exceeds the 5MB limit",
          };
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > PLUGIN_HTTP_MAX_BYTES) {
          return {
            ok: false,
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: "",
            url: response.url,
            error: "Response body exceeds the 5MB limit",
          };
        }
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: new TextDecoder().decode(buffer),
          url: response.url,
          error: null,
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.name === "TimeoutError"
              ? `Request timed out after ${timeout}ms`
              : error.message
            : String(error);
        return {
          ok: false,
          status: 0,
          statusText: "",
          headers: {},
          body: "",
          url,
          error: message,
        };
      }
    },
  );
};
