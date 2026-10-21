/** Browser tool output policy: never expose URL credentials/query/fragment or credential-shaped fields. */
const sensitiveKey =
  /cookie|token|authorization|password|secret|credential|api.?key|session.?id|^(?:e[_-]?ticket|epaas|service[_-]?key)$/i;
export const redactBrowserUrl = (value: string): string => {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "file:", "about:"].includes(url.protocol))
      return `${url.protocol}[redacted]`;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname
      .replace(
        /((?:token|secret|password|session|auth|key)[/=:])[^/]+/gi,
        "$1[redacted]",
      )
      .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");
    return url.toString();
  } catch {
    return "[redacted-url]";
  }
};
/**
 * 工具回执里的 URL 会被 redactBrowserUrl 去掉 query/hash 与凭据。
 * 回执必须显式标注这件事，否则调用方会把「脱敏后的 URL 没变」误判为
 * 地址栏未更新。只暴露「被隐藏的部分」，绝不还原真实 query。
 */
export type BrowserUrlRedactionInfo = {
  query: boolean;
  hash: boolean;
  note: string;
};

export const describeBrowserUrlRedaction = (
  value: string,
): BrowserUrlRedactionInfo | undefined => {
  try {
    const url = new URL(value);
    const query = url.search.length > 1;
    const hash = url.hash.length > 1;
    if (!query && !hash) return undefined;
    return {
      query,
      hash,
      note: "URL query/fragment are removed from tool output by the redaction policy (the browser address bar may still show them); read page state such as search fields instead.",
    };
  } catch {
    return undefined;
  }
};

export const redactBrowserText = (text: string): string =>
  text
    .replace(/(?:https?|file):\/\/[^\s<>"']+/gi, (value) =>
      redactBrowserUrl(value),
    )
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g,
      "[redacted]",
    )
    .replace(
      /(\b(?:e[_-]?ticket|epaas|service[_-]?key)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&"']+)/gi,
      '$1"[redacted]"',
    )
    .replace(
      /\b(cookie|set-cookie|token|authorization|password|secret|api[_-]?key)\s*[:=]\s*[^\r\n,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b[A-Za-z0-9_-]{64,}\b/g, "[redacted]");
/** browser-screenshot 支持的内联图片编码：只有这些 MIME 的原始数据可以跳过文本脱敏。 */
const SCREENSHOT_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const asScreenshotImage = (
  record: Record<string, unknown>,
): { type: "image"; mimeType: string; data: string } | null => {
  const { type, mimeType, data } = record;
  if (
    type !== "image" ||
    typeof mimeType !== "string" ||
    !SCREENSHOT_MIME_TYPES.has(mimeType) ||
    typeof data !== "string" ||
    data.length === 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
    return null;
  return { type: "image", mimeType, data };
};
export const redactBrowserResult = (
  value: unknown,
  allowScreenshot = false,
): unknown => {
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 20) return "[truncated]";
    if (typeof item === "string") return redactBrowserText(item);
    if (item === undefined) return null;
    if (typeof item === "bigint") return item.toString();
    if (!item || typeof item !== "object")
      return typeof item === "function" ? null : item;
    if (seen.has(item)) return "[circular]";
    const record = item as Record<string, unknown>;
    if (allowScreenshot) {
      const image = asScreenshotImage(record);
      if (image) return image;
    }
    seen.add(item);
    if (Array.isArray(item))
      return item.slice(0, 10000).map((child) => visit(child, depth + 1));
    return Object.fromEntries(
      Object.entries(item)
        .slice(0, 10000)
        .map(([key, child]) => [
          key,
          sensitiveKey.test(key) ? "[redacted]" : visit(child, depth + 1),
        ]),
    );
  };
  return visit(value, 0);
};
