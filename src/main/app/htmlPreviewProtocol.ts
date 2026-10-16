import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import type { NativeBridge } from "../native/types";
import { HTML_PREVIEW_SCHEME } from "../../shared/htmlPreview";

let registered = false;

/**
 * 注册 html-preview:// 自定义协议（HTML 渲染器的会话内预览）。
 *
 * URL 格式：html-preview://<文档 id>/
 *
 * 文档 id 即 host，每个文档一个独立源：iframe 不继承主窗口 CSP（内联脚本、
 * 样式与 CDN 资源可正常加载），也无法访问应用页面。文件路径由 Rust 按 id
 * 解析（id 非法或缓存缺失返回 null），渲染进程无法借此读取任意文件；只服务
 * 文档根路径，相对子资源一律 404。
 *
 * 必须在 app.whenReady() 之后调用。
 */
export const registerHtmlPreviewProtocol = (native: NativeBridge): void => {
  if (registered) {
    return;
  }
  registered = true;

  protocol.handle(HTML_PREVIEW_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.pathname !== "/" && url.pathname !== "/index.html") {
        return new Response("Not found", { status: 404 });
      }
      const filePath = await native.resolveHtmlPreviewFile(url.hostname);
      if (!filePath) {
        return new Response("HTML preview not found", { status: 404 });
      }
      const content = await readFile(filePath);
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // 内容寻址：同一 id 的内容永不变化。
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(`Failed to load HTML preview: ${message}`, {
        status: 500,
      });
    }
  });
};

/**
 * 在 app.whenReady 之前调用，声明 scheme 特权：standard 让 host 参与源计算
 * （每个文档独立源，localStorage 等按文档隔离），secure 让页面处于安全上下文。
 */
export const registerHtmlPreviewSchemePrivilege = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: HTML_PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: false,
      },
    },
  ]);
};
