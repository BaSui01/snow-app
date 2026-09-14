/**
 * 行级 Diff 引擎（纯算法，无 DOM 依赖，可在 Node 中直接引入抽查）。
 *
 * 设计要点：
 * - 行尾归一化：CRLF / CR 统一为 LF，避免仅行尾差异被当成改动；
 * - 末尾换行语义：末行换行不产生「幽灵空行」（"a\n" 与 "a" 视为同一内容），
 *   但文件中间的空行照常保留；
 * - 两级策略：先裁剪首尾公共行（大文件小幅改动时线性开销），中间段再做经典
 *   LCS 动态规划并回溯成 DiffLine 序列；
 * - 过大输入保护：中间段行数乘积 / 总行数超过阈值时退化为「全删 + 全增」，
 *   调用侧可用 isDiffTooLarge 提示降级。
 */

export type DiffLine = {
  kind: "add" | "del" | "ctx";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

/** DP 单元上限：中间段行数乘积超过它即降级（4,000,000 单元 ≈ 16MB Uint32）。 */
const MAX_DP_CELLS = 4_000_000;
/** 中间段总行数上限：超过它即降级（避免超长文件的二次方开销）。 */
const MAX_MID_LINES = 6_000;

/** 行尾归一化：CRLF / 单独 CR 一律转 LF。 */
const normalizeNewlines = (text: string): string =>
  text.replace(/\r\n?/g, "\n");

/**
 * 拆行：空文本为 0 行；末行换行不生成末尾空行（"a\n" 与 "a" 都是 1 行），
 * 中间空行照常保留。
 */
const splitLines = (text: string): string[] => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

type Prepared = {
  /** 归一化后的旧 / 新文件行。 */
  oldLines: string[];
  newLines: string[];
  /** 首尾公共行数（裁剪结果，头部 i 行与尾部 j 行完全相同）。 */
  head: number;
  tail: number;
  /** 首尾裁剪后的中间段（需要 DP 对齐的部分）。 */
  oldMid: string[];
  newMid: string[];
};

/** 归一化 + 首尾公共行快速裁剪（O(n)）。 */
const prepare = (oldText: string, newText: string): Prepared => {
  const oldLines = splitLines(normalizeNewlines(oldText));
  const newLines = splitLines(normalizeNewlines(newText));

  const maxHead = Math.min(oldLines.length, newLines.length);
  let head = 0;
  while (head < maxHead && oldLines[head] === newLines[head]) head += 1;

  const maxTail = maxHead - head;
  let tail = 0;
  while (
    tail < maxTail &&
    oldLines[oldLines.length - 1 - tail] ===
      newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  return {
    oldLines,
    newLines,
    head,
    tail,
    oldMid: oldLines.slice(head, oldLines.length - tail),
    newMid: newLines.slice(head, newLines.length - tail),
  };
};

const ctxLine = (text: string, oldNo: number, newNo: number): DiffLine => ({
  kind: "ctx",
  text,
  oldLine: oldNo,
  newLine: newNo,
});

const delLine = (text: string, oldNo: number): DiffLine => ({
  kind: "del",
  text,
  oldLine: oldNo,
  newLine: null,
});

const addLine = (text: string, newNo: number): DiffLine => ({
  kind: "add",
  text,
  oldLine: null,
  newLine: newNo,
});

/**
 * 输入是否超过 DP 保护阈值（中间段行数乘积 > 4,000,000 或中间段总行数 > 6000）。
 * 超限时 computeLineDiff 退化为「全删 + 全增」，调用侧可据此提示用户。
 */
export const isDiffTooLarge = (oldText: string, newText: string): boolean => {
  const { oldMid, newMid } = prepare(oldText, newText);
  return (
    oldMid.length * newMid.length > MAX_DP_CELLS ||
    oldMid.length + newMid.length > MAX_MID_LINES
  );
};

/**
 * 行级 LCS diff：返回按新文件阅读顺序排列的 DiffLine 序列。
 * - 首尾公共行先裁剪再 DP；
 * - 行号为 1-based：del/ctx 行带 oldLine，add/ctx 行带 newLine；
 * - 超限时中段输出「全删 + 全增」（isDiffTooLarge 可提前判定）。
 */
export const computeLineDiff = (
  oldText: string,
  newText: string,
): DiffLine[] => {
  const { oldLines, newLines, head, tail, oldMid, newMid } = prepare(
    oldText,
    newText,
  );
  const result: DiffLine[] = [];

  for (let i = 0; i < head; i += 1) {
    result.push(ctxLine(oldLines[i], i + 1, i + 1));
  }

  const n = oldMid.length;
  const m = newMid.length;
  if (n * m > MAX_DP_CELLS || n + m > MAX_MID_LINES) {
    // 保护降级：不做对齐，中段整体视为「全删 + 全增」。
    for (let i = 0; i < n; i += 1) {
      result.push(delLine(oldMid[i], head + i + 1));
    }
    for (let j = 0; j < m; j += 1) {
      result.push(addLine(newMid[j], head + j + 1));
    }
  } else {
    // 经典 LCS：table[i][j] = oldMid[i..] 与 newMid[j..] 的最长公共子序列长度。
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      const rowBase = i * width;
      const nextBase = rowBase + width;
      for (let j = m - 1; j >= 0; j -= 1) {
        table[rowBase + j] =
          oldMid[i] === newMid[j]
            ? table[nextBase + j + 1] + 1
            : Math.max(table[nextBase + j], table[rowBase + j + 1]);
      }
    }

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (oldMid[i] === newMid[j]) {
        result.push(ctxLine(oldMid[i], head + i + 1, head + j + 1));
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        result.push(delLine(oldMid[i], head + i + 1));
        i += 1;
      } else {
        result.push(addLine(newMid[j], head + j + 1));
        j += 1;
      }
    }
    for (; i < n; i += 1) result.push(delLine(oldMid[i], head + i + 1));
    for (; j < m; j += 1) result.push(addLine(newMid[j], head + j + 1));
  }

  for (let k = 0; k < tail; k += 1) {
    const oldIndex = oldLines.length - tail + k;
    const newIndex = newLines.length - tail + k;
    result.push(ctxLine(oldLines[oldIndex], oldIndex + 1, newIndex + 1));
  }

  return result;
};

/** 增删行计数（ctx 不计）。 */
export const diffStats = (
  lines: DiffLine[],
): {
  additions: number;
  deletions: number;
} => {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.kind === "add") additions += 1;
    else if (line.kind === "del") deletions += 1;
  }
  return { additions, deletions };
};

/**
 * 上下文折叠：只保留每处改动前后 context 行，其余未变更行折叠。
 *
 * 返回块序列，每块 lines 是需要展示的行，start 是它在原行序列中的起始下标
 * （相邻块之间未被覆盖的一律是 ctx 行，可据此生成「已折叠 N 行」占位）。
 * 无任何改动时返回空数组。
 */
export const toHunks = (
  lines: DiffLine[],
  context = 3,
): { lines: DiffLine[]; start: number }[] => {
  const changeIndexes: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].kind !== "ctx") changeIndexes.push(i);
  }
  if (changeIndexes.length === 0) return [];

  const hunks: { lines: DiffLine[]; start: number }[] = [];
  let start = Math.max(0, changeIndexes[0] - context);
  let end = Math.min(lines.length - 1, changeIndexes[0] + context);

  for (let k = 1; k < changeIndexes.length; k += 1) {
    const index = changeIndexes[k];
    if (index - context <= end + 1) {
      // 与当前块重叠 / 相邻：合并为同一块。
      end = Math.min(lines.length - 1, index + context);
      continue;
    }
    hunks.push({ lines: lines.slice(start, end + 1), start });
    start = Math.max(0, index - context);
    end = Math.min(lines.length - 1, index + context);
  }
  hunks.push({ lines: lines.slice(start, end + 1), start });

  return hunks;
};
