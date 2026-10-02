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
    if (
      allowScreenshot &&
      record.type === "image" &&
      record.mimeType === "image/png" &&
      typeof record.data === "string" &&
      /^[A-Za-z0-9+/=]+$/.test(record.data)
    ) {
      return { type: "image", mimeType: "image/png", data: record.data };
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
