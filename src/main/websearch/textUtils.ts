/** 文本处理工具（对齐 Snow CLI 的 text.utils.ts）。 */

/** 清理文本：压缩空白、解码 HTML 实体、去掉粗体标签。 */
export function cleanText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<b>/g, "")
    .replace(/<\/b>/g, "")
    .trim();
}
