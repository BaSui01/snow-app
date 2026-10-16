import { ipcRenderer } from "electron";
import type { HtmlPreviewDocument } from "../../shared/htmlPreview";

/** HTML 渲染器（html-render 工具卡片）API。 */
export const htmlPreviewApi = {
  /** 物化预览缓存（内容寻址，已存在则跳过），返回文档 id 与 file URL */
  prepareHtmlPreview: (
    html: string,
    title?: string,
  ): Promise<HtmlPreviewDocument> =>
    ipcRenderer.invoke("html-preview:prepare", html, title),

  /** 弹出保存对话框导出完整 HTML 文档，返回保存路径（取消为 null） */
  saveHtmlPreview: (html: string, title?: string): Promise<string | null> =>
    ipcRenderer.invoke("html-preview:save", html, title),
};
