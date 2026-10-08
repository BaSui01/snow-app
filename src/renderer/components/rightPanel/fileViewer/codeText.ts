const FOLD_TAB_WIDTH = 4;
const TAB_COLUMNS = 8;

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

/** 单行渲染最大安全字符数（超过时截断并提示，防止 Chromium Blink 排版引擎崩溃冻结） */
export const MAX_SAFE_LINE_RENDER_CHARS = 10000;

export const truncateLongLine = (
  lineText: string,
  maxChars = MAX_SAFE_LINE_RENDER_CHARS,
): { text: string; truncated: boolean; totalChars: number } => {
  if (lineText.length <= maxChars) {
    return { text: lineText, truncated: false, totalChars: lineText.length };
  }
  return {
    text: lineText.slice(0, maxChars),
    truncated: true,
    totalChars: lineText.length,
  };
};

const MAX_COLUMN_SCAN_LINES = 300;
const MAX_COLUMN_SCAN_CHARS = 30000;

export const estimateMaxColumns = (index: LineIndex): number => {
  const { text, starts, total } = index;
  let max = 0;
  let scanned = 0;

  // 采样策略：小文件全量扫描；大文件优先扫描前 100 行，随后跨步抽样至多 200 行，避免首屏冻结
  const linesToScan: number[] = [];
  if (total <= MAX_COLUMN_SCAN_LINES) {
    for (let l = 1; l <= total; l += 1) linesToScan.push(l);
  } else {
    for (let l = 1; l <= Math.min(100, total); l += 1) linesToScan.push(l);
    const step = Math.max(1, Math.floor((total - 100) / 200));
    for (let l = 101; l <= total; l += step) linesToScan.push(l);
  }

  for (const line of linesToScan) {
    const from = starts[line - 1];
    const to = line === total ? starts[total] : starts[line] - 1;
    const lineLen = to - from;
    // 单行过长时直接按字符数封顶估算，避免深层逐字符扫描
    if (lineLen > 2000) {
      if (lineLen > max) max = lineLen;
      scanned += lineLen;
      if (scanned > MAX_COLUMN_SCAN_CHARS) break;
      continue;
    }
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
    scanned += lineLen;
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

type HiddenInterval = {
  from: number;
  to: number;
  hiddenBefore: number;
  prefixHidden: number;
  visualBeforeEnd: number;
};

export const createLineMapping = (
  totalLines: number,
  collapsed: FoldRegion[],
): LineMapping => {
  const total = Math.max(1, totalLines);
  const clampLine = (line: number): number =>
    line < 1 ? 1 : line > total ? total : line;

  if (collapsed.length === 0) {
    const clamp = (value: number): number =>
      value < 1 ? 1 : value > total ? total : value;
    return { total, toVisual: clamp, toSource: clamp, isHidden: () => false };
  }

  // 1. 提取所有有效的隐藏区间 [start + 1, end]
  const rawIntervals: { from: number; to: number }[] = [];
  for (const r of collapsed) {
    const from = Math.max(1, r.start + 1);
    const to = Math.min(total, r.end);
    if (from <= to) {
      rawIntervals.push({ from, to });
    }
  }

  if (rawIntervals.length === 0) {
    const clamp = (value: number): number =>
      value < 1 ? 1 : value > total ? total : value;
    return { total, toVisual: clamp, toSource: clamp, isHidden: () => false };
  }

  // 按起始行排序并合并重叠/相连区间
  rawIntervals.sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [rawIntervals[0]];
  for (let i = 1; i < rawIntervals.length; i += 1) {
    const curr = rawIntervals[i];
    const prev = merged[merged.length - 1];
    if (curr.from <= prev.to + 1) {
      if (curr.to > prev.to) prev.to = curr.to;
    } else {
      merged.push(curr);
    }
  }

  // 2. 构建带前缀隐藏计数的非重叠区间
  const intervals: HiddenInterval[] = [];
  let accumulatedHidden = 0;
  for (const item of merged) {
    const hiddenCount = item.to - item.from + 1;
    const hiddenBefore = accumulatedHidden;
    accumulatedHidden += hiddenCount;
    const visualBeforeEnd = item.from - 1 - hiddenBefore;
    intervals.push({
      from: item.from,
      to: item.to,
      hiddenBefore,
      prefixHidden: accumulatedHidden,
      visualBeforeEnd,
    });
  }

  const visualTotal = Math.max(1, total - accumulatedHidden);

  // 二分查找：找到最后一个 from <= line 的区间下标，未找到返回 -1
  const findIntervalBySource = (line: number): number => {
    let lo = 0;
    let hi = intervals.length - 1;
    let res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (intervals[mid].from <= line) {
        res = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return res;
  };

  const getHiddenBefore = (line: number): number => {
    const idx = findIntervalBySource(line);
    if (idx === -1) return 0;
    const intv = intervals[idx];
    if (line >= intv.to) return intv.prefixHidden;
    return intv.hiddenBefore + (line - intv.from + 1);
  };

  const toVisual = (line: number): number => {
    const safe = clampLine(line);
    return Math.max(1, safe - getHiddenBefore(safe));
  };

  const toSource = (visual: number): number => {
    const target = visual < 1 ? 1 : visual > visualTotal ? visualTotal : visual;
    // 二分找到目标 visual 所在的段：找最后一个 visualBeforeEnd < target 的区间
    let lo = 0;
    let hi = intervals.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (intervals[mid].visualBeforeEnd < target) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx === -1) {
      return target;
    }
    return target + intervals[idx].prefixHidden;
  };

  const isHidden = (line: number): boolean => {
    const safe = clampLine(line);
    const idx = findIntervalBySource(safe);
    if (idx === -1) return false;
    return safe <= intervals[idx].to;
  };

  return { total: visualTotal, toVisual, toSource, isHidden };
};
