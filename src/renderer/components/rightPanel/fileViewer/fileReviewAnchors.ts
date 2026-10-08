import type { FileReviewTextAnchor } from "../../../../preload";
import type { LineIndex } from "./codeText";

export type FileReviewDraftAnchor = Omit<FileReviewTextAnchor, "sourceHash">;
export type FileReviewLocation = {
  status: "exact" | "relocated" | "outdated" | "ambiguous";
  start: number;
  end: number;
  startLine: number;
  endLine: number;
};

export const reviewLineAt = (index: LineIndex, offset: number): number => {
  let lo = 0;
  let hi = index.total;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (index.starts[mid] <= offset) lo = mid;
    else hi = mid;
  }
  return lo + 1;
};

/** 审阅标注的选区字符数上限（其余场景如「添加到会话」不设限）。 */
export const FILE_REVIEW_MAX_SELECTION_CHARS = 4096;

/**
 * 捕获代码区当前选区为文本锚点（起止行号 + 原文）。
 * Only accept selection endpoints inside real rendered source rows.
 */
export const captureFileTextSelection = (
  root: HTMLElement,
  index: LineIndex,
  representation: FileReviewTextAnchor["representation"],
  maxChars: number = FILE_REVIEW_MAX_SELECTION_CHARS,
): FileReviewDraftAnchor | null => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
    return null;
  const range = selection.getRangeAt(0);
  const endpoint = (node: Node, offset: number): number | null => {
    const element = node instanceof Element ? node : node.parentElement;
    const row = element?.closest<HTMLElement>(
      ".file-viewer-code-line[data-line]",
    );
    if (!row || !root.contains(row)) return null;
    const line = Number(row.dataset.line);
    if (!Number.isInteger(line) || line < 1 || line > index.total) return null;
    const prefix = document.createRange();
    prefix.selectNodeContents(row);
    prefix.setEnd(node, offset);
    const column = prefix.toString().length;
    if (column > index.getLine(line).length) return null;
    return index.starts[line - 1] + column;
  };
  const start = endpoint(range.startContainer, range.startOffset);
  const end = endpoint(range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start || end - start > maxChars)
    return null;
  const startLine = reviewLineAt(index, start);
  const endLine = reviewLineAt(index, end - 1);
  // A DOM selection across folded or virtualized-away rows must not silently
  // quote source text the user did not select on screen.
  for (let line = startLine; line <= endLine; line += 1) {
    const row = root.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (
      !row ||
      (line < endLine &&
        row.classList.contains("file-viewer-code-line--folded"))
    )
      return null;
  }
  const splitsSurrogatePair = (offset: number): boolean => {
    const left = index.text.charCodeAt(offset - 1);
    const right = index.text.charCodeAt(offset);
    return (
      left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff
    );
  };
  if (splitsSurrogatePair(start) || splitsSurrogatePair(end)) return null;
  let beforeStart = Math.max(0, start - 80);
  let afterEnd = Math.min(index.text.length, end + 80);
  if (splitsSurrogatePair(beforeStart)) beforeStart += 1;
  if (splitsSurrogatePair(afterEnd)) afterEnd -= 1;
  const quote = index.text.slice(start, end);
  if (!quote.trim()) return null;
  return {
    kind: "text-range",
    representation,
    start,
    end,
    startLine,
    endLine,
    quote,
    before: index.text.slice(beforeStart, start),
    after: index.text.slice(end, afterEnd),
  };
};

export const hashFileReviewText = async (text: string): Promise<string> => {
  const digest = await window.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

export const parseFileReviewAnchor = (
  json: string,
): FileReviewTextAnchor | null => {
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object") return null;
    const a = value as FileReviewTextAnchor;
    if (
      a.kind !== "text-range" ||
      !["source", "extracted-text"].includes(a.representation) ||
      !Number.isSafeInteger(a.start) ||
      !Number.isSafeInteger(a.end) ||
      a.start < 0 ||
      a.end <= a.start ||
      !Number.isSafeInteger(a.startLine) ||
      !Number.isSafeInteger(a.endLine) ||
      a.startLine < 1 ||
      a.endLine < a.startLine ||
      typeof a.quote !== "string" ||
      !a.quote.trim() ||
      a.quote.length > 4096 ||
      a.end - a.start !== a.quote.length ||
      typeof a.before !== "string" ||
      a.before.length > 80 ||
      typeof a.after !== "string" ||
      a.after.length > 80 ||
      typeof a.sourceHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(a.sourceHash)
    )
      return null;
    return a;
  } catch {
    return null;
  }
};

export const resolveFileReviewAnchor = (
  anchor: FileReviewTextAnchor,
  index: LineIndex,
  sourceHash: string,
  representation: FileReviewTextAnchor["representation"],
): FileReviewLocation => {
  const fallback: FileReviewLocation = {
    status: "outdated",
    start: anchor.start,
    end: anchor.end,
    startLine: anchor.startLine,
    endLine: anchor.endLine,
  };
  if (anchor.representation !== representation) return fallback;
  const location = (
    start: number,
    status: FileReviewLocation["status"],
  ): FileReviewLocation => ({
    status,
    start,
    end: start + anchor.quote.length,
    startLine: reviewLineAt(index, start),
    endLine: reviewLineAt(index, start + anchor.quote.length - 1),
  });
  if (
    sourceHash === anchor.sourceHash &&
    index.text.slice(anchor.start, anchor.end) === anchor.quote
  ) {
    return location(anchor.start, "exact");
  }
  // Match the entire context once; a second match is ambiguity, not an excuse
  // to pick the nearest line. No fuzzy matching or silent persisted re-anchoring.
  const needle = anchor.before + anchor.quote + anchor.after;
  const first = index.text.indexOf(needle);
  if (first < 0) return fallback;
  if (index.text.indexOf(needle, first + 1) >= 0)
    return { ...fallback, status: "ambiguous" };
  return location(first + anchor.before.length, "relocated");
};
