import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import type { NativeBridge } from "../../native/types";
import type { HtmlPreviewDocument } from "../../../shared/htmlPreview";

/** 文件名非法字符（Windows 最严格集合）与控制字符。 */
const INVALID_FILE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const MAX_FILE_NAME_LENGTH = 80;

const normalizeTitle = (title: unknown): string | null =>
  typeof title === "string" && title.trim() ? title.trim() : null;

const toFileName = (title: string | null): string => {
  const base = (title ?? "")
    .replace(INVALID_FILE_NAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH)
    .replace(/[. ]+$/, "");
  return `${base || "page"}.html`;
};

const requireHtml = (html: unknown): string => {
  if (typeof html !== "string" || !html.trim()) {
    throw new Error("HTML content is required");
  }
  return html;
};

/**
 * HTML 渲染器（html-render 工具卡片）IPC。规范化、内容寻址落盘与导出写盘
 * 均由 Rust 完成，主进程只负责参数校验与保存对话框。
 *
 * - `html-preview:prepare`：物化预览缓存，返回文档 id / file URL 等
 * - `html-preview:save`：弹出保存对话框并导出完整文档，返回保存路径（取消为 null）
 */
export const registerHtmlPreviewHandlers = (native: NativeBridge): void => {
  ipcMain.handle(
    "html-preview:prepare",
    async (
      _event,
      html: unknown,
      title: unknown,
    ): Promise<HtmlPreviewDocument> =>
      native.materializeHtmlPreview(requireHtml(html), normalizeTitle(title)),
  );

  ipcMain.handle(
    "html-preview:save",
    async (event, html: unknown, title: unknown): Promise<string | null> => {
      const content = requireHtml(html);
      const normalizedTitle = normalizeTitle(title);
      const options: Electron.SaveDialogOptions = {
        title: "Save HTML",
        defaultPath: join(
          app.getPath("downloads"),
          toFileName(normalizedTitle),
        ),
        filters: [{ name: "HTML", extensions: ["html", "htm"] }],
      };
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const result = browserWindow
        ? await dialog.showSaveDialog(browserWindow, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) {
        return null;
      }
      await native.exportHtmlPreview(content, normalizedTitle, result.filePath);
      return result.filePath;
    },
  );
};
