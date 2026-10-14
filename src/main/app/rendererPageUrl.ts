import { is } from "@electron-toolkit/utils";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 独立窗口渲染页地址：开发模式指向 Vite dev server，生产模式指向打包后的
 * out/renderer 静态页面。query 携带窗口初始化参数（如实例 id / 面板 token）。
 */
export const buildRendererPageUrl = (
  pageName: string,
  query: URLSearchParams,
): string => {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}/${pageName}?${query.toString()}`;
  }
  const pageUrl = pathToFileURL(
    join(import.meta.dirname, "../renderer", pageName),
  ).toString();
  return `${pageUrl}?${query.toString()}`;
};
