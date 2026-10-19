import { redactBrowserResult } from "../../../../../shared/browserRedaction";

const MAX_TEXT = 16000;
const MAX_ITEMS = 200;
const MAX_JSON = 40000;
const PRIVATE_FIELD =
  /cookie|token|authorization|password|secret|credential|api.?key|session.?id|private.?key/i;

type BrowserDisplayCollectionInfo = {
  size: number;
  objectRows?: boolean;
};
// Safe copies retain only structural facts, never a reference to the raw result.
const collectionInfo = new WeakMap<object, BrowserDisplayCollectionInfo>();
export const getBrowserDisplayCollectionInfo = (
  value: unknown,
): BrowserDisplayCollectionInfo | undefined =>
  value !== null && typeof value === "object"
    ? collectionInfo.get(value)
    : undefined;

/** Presentation-only: bound and redact unknown data without mutating the stored tool result. */
export const sanitizeBrowserDisplayValue = (value: unknown): unknown => {
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number, original: unknown): unknown => {
    if (depth > 12) return "[truncated]";
    if (typeof item === "string") {
      return item.length > MAX_TEXT
        ? `${item.slice(0, MAX_TEXT)}\n[truncated]`
        : item;
    }
    if (item === null || typeof item !== "object") return item;
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    if (Array.isArray(item)) {
      const source = Array.isArray(original) ? original : item;
      const result = item
        .slice(0, MAX_ITEMS)
        .map((child, index) => visit(child, depth + 1, source[index]));
      collectionInfo.set(
        result,
        getBrowserDisplayCollectionInfo(source) ?? {
          size: source.length,
          objectRows: source.every(
            (child) =>
              child !== null &&
              typeof child === "object" &&
              !Array.isArray(child),
          ),
        },
      );
      return result;
    }
    const record = item as Record<string, unknown>;
    const source =
      original !== null && typeof original === "object"
        ? (original as Record<string, unknown>)
        : record;
    const fieldName =
      typeof record.name === "string" ? record.name : record.key;
    const privateEntry =
      typeof fieldName === "string" && PRIVATE_FIELD.test(fieldName);
    const result = Object.fromEntries(
      Object.entries(record)
        .slice(0, MAX_ITEMS)
        .map(([key, child]) => [
          key,
          PRIVATE_FIELD.test(key) ||
          /headers$/i.test(key) ||
          (privateEntry && /^(?:value|values)$/i.test(key))
            ? "[redacted]"
            : visit(child, depth + 1, source[key]),
        ]),
    );
    collectionInfo.set(
      result,
      getBrowserDisplayCollectionInfo(source) ?? {
        size: Object.keys(source).length,
      },
    );
    return result;
  };
  return visit(redactBrowserResult(value), 0, value);
};

export const formatBrowserDisplayJson = (value: unknown): string => {
  const safe = sanitizeBrowserDisplayValue(value);
  const text = JSON.stringify(safe, null, 2) ?? "null";
  const hasTruncatedCollection = (item: unknown): boolean => {
    if (item === null || typeof item !== "object") return false;
    const values = Object.values(item);
    const shown = Array.isArray(item) ? item.length : values.length;
    return (
      (getBrowserDisplayCollectionInfo(item)?.size ?? shown) > shown ||
      values.some(hasTruncatedCollection)
    );
  };
  return text.length > MAX_JSON || hasTruncatedCollection(safe)
    ? `${text.slice(0, MAX_JSON)}\n[truncated]`
    : text;
};

export type BrowserOutcome = {
  kind: "success" | "partial" | "error" | "neutral";
  message?: string;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const failure = (
  value: Record<string, unknown> | null,
): BrowserOutcome | null => {
  if (!value) return null;
  const message =
    typeof value.error === "string" && value.error.trim()
      ? value.error
      : undefined;
  return message || value.ok === false || value.success === false
    ? { kind: "error", message }
    : null;
};

/** Only operation envelopes carry execution status; page data and audit findings do not. */
export const getBrowserOutcome = (
  operation: string,
  args: Record<string, unknown> | null,
  data: Record<string, unknown> | null,
): BrowserOutcome => {
  if (!data) return { kind: "success" };
  if (operation === "fill_form") {
    const results = Array.isArray(data.results) ? data.results : [];
    const failed =
      typeof data.failureCount === "number"
        ? data.failureCount
        : results.filter((item) => record(item)?.ok === false).length;
    const succeeded =
      typeof data.successCount === "number"
        ? data.successCount
        : results.filter((item) => record(item)?.ok === true).length;
    if (failed > 0) return { kind: succeeded > 0 ? "partial" : "error" };
  }
  const topLevelFailure = failure(data);
  if (topLevelFailure) return topLevelFailure;
  if (
    (operation === "performance_start_trace" ||
      operation === "screencast_start") &&
    data.started === false
  ) {
    return { kind: "error" };
  }
  if (operation === "performance_stop_trace") {
    const traceFailure = failure(record(data.trace));
    if (traceFailure) return traceFailure;
  }
  if (
    operation === "frames" &&
    Array.isArray(data.unavailable) &&
    data.unavailable.length > 0
  ) {
    return {
      kind:
        Array.isArray(data.frames) && data.frames.length > 0
          ? "partial"
          : "error",
    };
  }
  if (operation === "request_share" && data.shared === false)
    return { kind: "neutral" };
  if (operation === "devtools") {
    if (args?.action === "trace")
      return failure(record(data.trace)) ?? { kind: "success" };
    if (args?.action === "storageSave" || args?.action === "storageRestore") {
      const storage = record(data.storage);
      const failed = failure(storage);
      if (failed) return failed;
      if (
        storage &&
        Object.entries(storage).some(
          ([key, value]) =>
            /Failures$/.test(key) && typeof value === "number" && value > 0,
        )
      ) {
        return { kind: "partial" };
      }
    }
    if (
      (args?.action === "network_detail" ||
        args?.action === "networkDetails") &&
      (data.found === false || record(data.details)?.found === false)
    ) {
      return { kind: "neutral" };
    }
  }
  if (operation === "performance_analyze_insight" && data.found === false)
    return { kind: "neutral" };
  return { kind: "success" };
};
