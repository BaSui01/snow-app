const FOLD_TAB_WIDTH = 4;
const TAB_COLUMNS = 8;
const MAX_COLUMN_SCAN_CHARS = 2000000;

export const DEFAULT_LINE_HEIGHT = 20;

export type FoldRegion = { start: number; end: number };

export type LineIndex = {
  text: string;
  total: number;
  starts: Int32Array;
  getLine: (line: number) => string;
};

export const countTextLines = (text: string): number => {
  let total = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) total += 1;
  }
  return total;
};

export const createLineIndex = (text: string): LineIndex => {
  const total = countTextLines(text);
  const starts = new Int32Array(total + 1);
  let cursor = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      starts[cursor] = i + 1;
      cursor += 1;
    }
  }
  starts[total] = text.length;
  const getLine = (line: number): string => {
    const safe = line < 1 ? 1 : line > total ? total : line;
    const from = starts[safe - 1];
    const to = safe === total ? starts[total] : starts[safe] - 1;
    const value = text.slice(from, Math.max(from, to));
    return value.endsWith("\r") ? value.slice(0, -1) : value;
  };
  return { text, total, starts, getLine };
};

export const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const estimateMaxColumns = (index: LineIndex): number => {
  const { text, starts, total } = index;
  let max = 0;
  let scanned = 0;
  for (let line = 1; line <= total; line += 1) {
    const from = starts[line - 1];
    const to = line === total ? starts[total] : starts[line] - 1;
    let columns = 0;
    for (let i = from; i < to; i += 1) {
      const code = text.charCodeAt(i);
      if (code === 9) {
        columns += TAB_COLUMNS - (columns % TAB_COLUMNS);
      } else if (code >= 0x1100) {
        columns += 2;
      } else {
        columns += 1;
      }
    }
    if (columns > max) max = columns;
    scanned += to - from;
    if (scanned > MAX_COLUMN_SCAN_CHARS) break;
  }
  return max;
};

export const computeFoldRegions = (index: LineIndex): FoldRegion[] => {
  const { text, starts, total } = index;
  const regions: FoldRegion[] = [];
  const stackIndent: number[] = [];
  const stackLine: number[] = [];
  let previous = -1;
  let previousColumns = 0;
  for (let line = 1; line <= total; line += 1) {
    const from = starts[line - 1];
    const to = line === total ? starts[total] : starts[line] - 1;
    let cursor = from;
    let columns = 0;
    while (cursor < to) {
      const code = text.charCodeAt(cursor);
      if (code === 32) {
        columns += 1;
      } else if (code === 9) {
        columns += FOLD_TAB_WIDTH - (columns % FOLD_TAB_WIDTH);
      } else {
        break;
      }
      cursor += 1;
    }
    let blank = cursor >= to;
    if (!blank && text.charCodeAt(cursor) <= 32) {
      blank = true;
      for (let i = cursor; i < to; i += 1) {
        if (text.charCodeAt(i) > 32) {
          blank = false;
          break;
        }
      }
    }
    if (blank) continue;
    while (
      stackIndent.length > 0 &&
      stackIndent[stackIndent.length - 1] >= columns
    ) {
      stackIndent.pop();
      const openLine = stackLine.pop() as number;
      if (previous > openLine) {
        regions.push({ start: openLine, end: previous });
      }
    }
    if (previous >= 0 && columns > previousColumns) {
      stackIndent.push(previousColumns);
      stackLine.push(previous);
    }
    previous = line;
    previousColumns = columns;
  }
  while (stackIndent.length > 0) {
    stackIndent.pop();
    const openLine = stackLine.pop() as number;
    if (previous > openLine) {
      regions.push({ start: openLine, end: previous });
    }
  }
  regions.sort((a, b) => a.start - b.start);
  return regions;
};

export const splitHighlightedHtmlLines = (html: string): string[] => {
  const lines: string[] = [];
  const openTags: { name: string; raw: string }[] = [];
  let current = "";
  let index = 0;
  while (index < html.length) {
    const char = html[index];
    if (char === "\n") {
      lines.push(current + openTags.map((tag) => `</${tag.name}>`).join(""));
      current = openTags.map((tag) => tag.raw).join("");
      index += 1;
      continue;
    }
    if (char === "<") {
      const end = html.indexOf(">", index);
      if (end === -1) {
        current += html.slice(index);
        break;
      }
      const raw = html.slice(index, end + 1);
      if (raw.startsWith("</")) {
        openTags.pop();
      } else if (!raw.endsWith("/>")) {
        openTags.push({
          name: /^<([a-zA-Z0-9-]+)/.exec(raw)?.[1] ?? "span",
          raw,
        });
      }
      current += raw;
      index = end + 1;
      continue;
    }
    current += char;
    index += 1;
  }
  lines.push(current);
  return lines;
};

export type LineMapping = {
  total: number;
  toVisual: (line: number) => number;
  toSource: (visual: number) => number;
  isHidden: (line: number) => boolean;
};

export const createLineMapping = (
  totalLines: number,
  collapsed: FoldRegion[],
): LineMapping => {
  const total = Math.max(1, totalLines);
  if (collapsed.length === 0) {
    const clamp = (value: number): number =>
      value < 1 ? 1 : value > total ? total : value;
    return { total, toVisual: clamp, toSource: clamp, isHidden: () => false };
  }
  const prefix = new Int32Array(total + 1);
  const regions = [...collapsed].sort((a, b) => a.start - b.start);
  let regionIndex = 0;
  let coveredUntil = 0;
  let hidden = 0;
  for (let line = 1; line <= total; line += 1) {
    while (regionIndex < regions.length && regions[regionIndex].start < line) {
      if (regions[regionIndex].end > coveredUntil) {
        coveredUntil = regions[regionIndex].end;
      }
      regionIndex += 1;
    }
    if (line <= coveredUntil) hidden += 1;
    prefix[line] = hidden;
  }
  const visualTotal = Math.max(1, total - hidden);
  const clampLine = (line: number): number =>
    line < 1 ? 1 : line > total ? total : line;
  const toVisual = (line: number): number => {
    const safe = clampLine(line);
    return safe - prefix[safe];
  };
  const toSource = (visual: number): number => {
    const target = visual < 1 ? 1 : visual > visualTotal ? visualTotal : visual;
    let lo = 1;
    let hi = total;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (mid - prefix[mid] >= target) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const isHidden = (line: number): boolean => {
    const safe = clampLine(line);
    if (safe <= 1) return false;
    return safe - prefix[safe] === safe - 1 - prefix[safe - 1];
  };
  return { total: visualTotal, toVisual, toSource, isHidden };
};
