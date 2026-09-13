/** 按 id 取元素：所有 id 都由 index.html 静态提供，找不到即视为构建错误。 */
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/** HTML 转义：所有拼接进 innerHTML 的动态文本必须经过它。 */
export const escapeHtml = (value: unknown): string =>
  String(value == null ? "" : value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
