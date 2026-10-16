/**
 * HTML 渲染器（html-render 工具）预览的跨进程共享定义。
 *
 * 预览文档由 Rust 规范化后按内容寻址写入 ~/.snowapp/html-preview/<id>.html，
 * 渲染层 iframe 通过 html-preview://<id>/ 加载：独立源（每个文档一个 host），
 * 不继承主窗口 CSP，内联脚本可正常执行，且无法访问应用页面。
 */

/** 预览文档自定义协议名（主进程注册，CSP frame-src 放行）。 */
export const HTML_PREVIEW_SCHEME = "html-preview";

/** 已物化的预览文档信息（Rust materialize_html_preview 返回）。 */
export type HtmlPreviewDocument = {
  /** 内容寻址 id（32 位小写十六进制），同时作为协议 URL 的 host。 */
  id: string;
  /** 解析后的标题：显式标题优先，否则取文档 <title>。 */
  title: string;
  /** 缓存文件绝对路径。 */
  filePath: string;
  /** 缓存文件 file:// URL（内置浏览器打开用）。 */
  fileUrl: string;
  /** 规范化文档的字节数。 */
  bytes: number;
};

/** 构造预览文档的 iframe 地址。 */
export const htmlPreviewUrl = (id: string): string =>
  `${HTML_PREVIEW_SCHEME}://${id}/`;
