/**
 * filesystem 工具族卡片：filesystem-read / filesystem-replace_edit / filesystem-create。
 *
 * 数据契约（字段语义与桌面 Filesystem*ToolCall 的解析逐字段对齐，字段名以 Rust 端为准）：
 * - read：参数 filePath（字符串 / 数组 / JSON 数组字符串 → 多文件）、startLine、endLine
 *   （offset / limit 作为兼容别名兜底）；结果 { content, totalLines, startLine, endLine }
 *   —— content 由 Rust 端预先加好 `     1: ` 行号前缀；目录结果只有 { content }
 *   （每行一个条目，子目录以 "/" 结尾）；图片 { content: "@@image:…@@", mediaType,
 *   isImage }；多文件 { files: [{ filePath, … }] }；
 * - replace_edit：参数 filePath / searchContent / replaceContent / occurrence；成功结果
 *   { success, totalMatches, occurrence, matchType, matchedLineStart, matchedLineEnd }；
 * - create：参数 filePath / content / overwrite / encoding（isDirectory 为兼容字段）；
 *   成功结果 { success, path, bytes, lines }。
 *
 * 截断（远控桥对 arguments ≤2000、result ≤12000 字符，尾部追加「\n…（手机端已截断）」）：
 * - 参数被截断 ⇒ 半截 JSON 解析失败 ⇒ **一律不渲染 diff**：searchContent /
 *   replaceContent / content 都可能是残缺片段，画成 diff 会误导阅读；此时给出明确
 *   提示 + 原始参数文本，并用宽松取串抢救 filePath / content 做降级预览；
 * - 结果被截断 ⇒ 结构化字段通常仍完整，照常解析，另加「内容已截断」提示。
 *
 * 契约：卡片骨架走 tools/ui.ts 的 createToolNode（头部徽章/摘要、状态、折叠体），
 * 行级 diff 视图走 tools/diffView.ts 的 renderDiffView（样式在 diff.css，本模块不重复
 * 定义）；本模块类名统一 tc-fs-*（styles/tools/filesystem.css）。所有文本一律
 * createElement + textContent，数据不进 innerHTML（图标为静态 lucide 标记）。
 */
import type { SnowRemoteToolCall } from "../../renderer/types/remoteControl";
import { t } from "../i18n";
import { iconMarkup, type MobileIconName } from "../icons";
import { computeLineDiff, diffStats, type DiffLine } from "./diff";
import { renderDiffView } from "./diffView";
import type { ToolCallRenderer, ToolModule } from "./types";
import {
  argsSummary,
  createToolNode,
  decodeEscapedNewlines,
  formatJson,
  isTruncated,
  parseJsonRecord,
  resolveStatus,
  tcBadge,
  tcErrorRow,
  tcKv,
  tcPre,
  tcSection,
  type JsonRecord,
} from "./ui";

// ── 通用小件 ──────────────────────────────────────────────────────────────

/** read 内容块的折叠阈值（行数；Rust 端内容已带行号前缀）。 */
const CONTENT_FOLD_LINES = 20;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** 静态 lucide 图标（只承载图标标记，不含数据，可安全走 innerHTML）。 */
const iconSpan = (name: MobileIconName, className: string): HTMLSpanElement => {
  const span = el("span", className);
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconMarkup(name);
  return span;
};

/** 文件名（兼容 Windows / POSIX 分隔符；无分隔符时原样返回）。 */
const fileNameOf = (filePath: string): string =>
  filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;

/** 数字字段读取（非有限数字一律视为缺失）。 */
const numberOf = (
  record: JsonRecord | null,
  key: string,
): number | undefined => {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

/** tcPre 结果里的 pre（超阈值时在 .tc-fold 内部，折叠协议见 base.css）。 */
const preOf = (node: HTMLElement): HTMLElement =>
  node.tagName === "PRE" ? node : (node.querySelector("pre") ?? node);

/** 完整路径行（等宽、任意位置可换行）。 */
const pathRow = (filePath: string): HTMLElement =>
  el("div", "tc-fs-path", filePath);

/** 提示行（截断 / 降级 / 统计说明）。 */
const noteRow = (
  message: string,
  variant: "muted" | "warn" = "muted",
): HTMLElement => el("div", `tc-fs-note tc-fs-note-${variant}`, message);

/** 结论行（匹配位置 / 创建完成）。 */
const successRow = (message: string): HTMLElement =>
  el("div", "tc-fs-success", message);

/** 增删统计（+n；有删除时才补 −m）——summary 的 meta 区。 */
const statsNode = (stats: {
  additions: number;
  deletions: number;
}): HTMLElement => {
  const wrap = el("span", "tc-fs-stats");
  wrap.append(el("span", "tc-fs-stat-add", `+${stats.additions}`));
  if (stats.deletions > 0) {
    wrap.append(el("span", "tc-fs-stat-del", `-${stats.deletions}`));
  }
  return wrap;
};

/** 12px 小图标（目录条目 / 多文件段落标题）。 */
const fileIcon = (name: MobileIconName): HTMLElement => {
  const icon = el("span", "tc-fs-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = iconMarkup(name);
  return icon;
};

/** 条目清单（目录列表 / 待读取路径）。 */
const entryList = (
  items: { icon: MobileIconName; label: string }[],
): HTMLElement => {
  const list = el("div", "tc-fs-list");
  for (const item of items) {
    const row = el("div", "tc-fs-row");
    row.append(fileIcon(item.icon), el("span", "tc-fs-name", item.label));
    list.append(row);
  }
  return list;
};

/**
 * 内容块：Rust 端已给每行加了 `     1: ` 行号前缀，这里按等宽文本原样展示，
 * 超过折叠阈值时由 tcPre 生成 .tc-fold + .tc-more（展开态由 timeline.ts 委托切换）。
 */
const contentBlock = (text: string): HTMLElement => {
  const block = tcPre(text, { maxLines: CONTENT_FOLD_LINES });
  preOf(block).classList.add("tc-fs-code");
  return block;
};

/** diff 容器：与正文同栅格（min-width: 0 防长行撑破；行级样式见 diff.css）。 */
const diffBlock = (node: HTMLElement): HTMLElement => {
  const wrap = el("div", "tc-fs-diff");
  wrap.append(node);
  return wrap;
};

/** 参数回退块：可解析时美化 JSON，否则还原字面转义后的原文（无内容返回 null）。 */
const argsFallbackSection = (
  record: JsonRecord | null,
  raw?: string,
): HTMLElement | null => {
  const text = record
    ? formatJson(record)
    : decodeEscapedNewlines((raw ?? "").trim());
  return text === ""
    ? null
    : tcSection(t("remote.toolCall.common.arguments"), tcPre(text));
};

/** 结果原文块（无法解析为结构化结果时的兜底：提示 + 原文）。 */
const rawResultSection = (raw: string): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  fragment.append(noteRow(t("remote.toolCall.filesystem.rawFallback")));
  if (isTruncated(raw)) {
    fragment.append(noteRow(t("remote.toolCall.common.truncated"), "warn"));
  }
  fragment.append(
    tcSection(
      t("remote.toolCall.common.result"),
      tcPre(decodeEscapedNewlines(raw)),
    ),
  );
  return fragment;
};

/**
 * 远控桥的截断后缀（与 tools/ui.ts 的 TRUNCATION_SUFFIX 同源；那边未导出该常量，
 * 宽松取串时必须按长度剥掉，否则后缀文案会被当成内容的一部分）。
 */
const TRUNCATION_SUFFIX = "\n…（手机端已截断）";

/**
 * 半截 JSON 的宽松取串：定位 `"key"` 后的字符串字面量起点，按 JSON 转义规则解出
 * 已到达的部分；遇到未转义的收尾引号或文本末尾即停。仅用于参数被截断时的降级
 * 预览（解析成功的参数走 parseJsonRecord，不经过这里）。
 */
const partialString = (raw: string | undefined, key: string): string | null => {
  if (!raw) return null;
  const text = isTruncated(raw) ? raw.slice(0, -TRUNCATION_SUFFIX.length) : raw;
  const marker = `"${key}"`;
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const colon = text.indexOf(":", at + marker.length);
  if (colon < 0) return null;
  let index = colon + 1;
  while (index < text.length && text[index] !== '"') index += 1;
  if (text[index] !== '"') return null;

  const escapes: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  };
  let out = "";
  index += 1;
  while (index < text.length) {
    const ch = text[index];
    if (ch === '"') break;
    if (ch !== "\\") {
      out += ch;
      index += 1;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) break; // 半截转义序列：丢弃
    const mapped = escapes[next];
    if (mapped !== undefined) {
      out += mapped;
      index += 2;
      continue;
    }
    if (next === "u") {
      const code = Number.parseInt(text.slice(index + 2, index + 6), 16);
      if (!Number.isInteger(code)) break;
      out += String.fromCharCode(code);
      index += 6;
      continue;
    }
    out += next;
    index += 2;
  }
  return out;
};

/** 从（可能被截断的）参数原文里抢救出 filePath 用于降级展示。 */
const recoverPath = (raw?: string): string | undefined =>
  partialString(raw, "filePath") || undefined;

/**
 * 给框架产出的头部徽章（.tool-name）补一枚 lucide 图标：createToolNode 的 badge
 * 只接受字符串文案，这里在节点生成后把文案包进 .tc-fs-badge-text 并在其前面插入
 * 图标（结构/样式见 styles/tools/filesystem.css 的 .tc-fs-badge*）。
 */
const withBadgeIcon = (
  node: HTMLElement,
  icon: MobileIconName,
): HTMLElement => {
  const badge = node.querySelector<HTMLElement>(".tool-name");
  if (!badge) return node;
  const label = el("span", "tc-fs-badge-text", badge.textContent ?? "");
  badge.textContent = "";
  badge.classList.add("tc-fs-badge");
  badge.append(iconSpan(icon, "tc-fs-badge-icon"), label);
  return node;
};

// ── read ─────────────────────────────────────────────────────────────────

type ReadPathItem = { path: string; startLine?: number; endLine?: number };

type ReadArgs = {
  isMulti: boolean;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  paths?: ReadPathItem[];
};

type ReadFileResult =
  | {
      type: "file";
      content: string;
      totalLines: number;
      startLine: number;
      endLine: number;
    }
  | { type: "directory"; entries: string[] }
  | { type: "image"; content: string; mediaType: string }
  | { type: "error"; message: string }
  | { type: "raw"; text: string };

type ReadResult =
  | ReadFileResult
  | { type: "multi"; files: { filePath: string; result: ReadFileResult }[] }
  | { type: "empty" };

/** 解析多文件参数项（字符串或 { path, startLine, endLine } 对象）。 */
const parsePathItems = (
  items: unknown[],
  defaultStartLine?: number,
  defaultEndLine?: number,
): ReadPathItem[] => {
  const paths: ReadPathItem[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (item) {
        paths.push({
          path: item,
          startLine: defaultStartLine,
          endLine: defaultEndLine,
        });
      }
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const record = item as JsonRecord;
    if (typeof record.path !== "string" || !record.path) continue;
    paths.push({
      path: record.path,
      startLine:
        typeof record.startLine === "number"
          ? record.startLine
          : defaultStartLine,
      endLine:
        typeof record.endLine === "number" ? record.endLine : defaultEndLine,
    });
  }
  return paths;
};

/**
 * 解析 read 参数：多文件时 filePath 为数组，或 Rust 侧上报的 JSON 数组字符串。
 * 行区间优先 startLine / endLine，缺失时接受 offset（起始行）/ limit（行数）别名。
 */
const parseReadArgs = (record: JsonRecord | null): ReadArgs | null => {
  if (!record) return null;
  const offset = numberOf(record, "offset");
  const limit = numberOf(record, "limit");
  const defaultStartLine = numberOf(record, "startLine") ?? offset;
  const defaultEndLine =
    numberOf(record, "endLine") ??
    (offset !== undefined && limit !== undefined ? offset + limit - 1 : limit);
  const filePath = record.filePath;

  if (Array.isArray(filePath)) {
    const paths = parsePathItems(filePath, defaultStartLine, defaultEndLine);
    return paths.length ? { isMulti: true, paths } : null;
  }
  if (typeof filePath === "string" && filePath) {
    const trimmed = filePath.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const arr: unknown = JSON.parse(trimmed);
        if (Array.isArray(arr)) {
          const paths = parsePathItems(arr, defaultStartLine, defaultEndLine);
          if (paths.length) return { isMulti: true, paths };
        }
      } catch {
        // 不是合法 JSON 数组：按普通单文件路径处理。
      }
    }
    return {
      isMulti: false,
      filePath,
      startLine: defaultStartLine,
      endLine: defaultEndLine,
    };
  }
  return null;
};

/** 单个文件的结果（错误 / 图片 / 带行号的文本 / 目录列表 / 原文）。 */
const parseSingleReadResult = (value: unknown, raw: string): ReadFileResult => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { type: "raw", text: raw };
  }
  const record = value as JsonRecord;
  if (typeof record.error === "string") {
    return { type: "error", message: record.error };
  }
  if (typeof record.content !== "string") {
    return { type: "raw", text: raw };
  }

  if (record.isImage === true) {
    return {
      type: "image",
      content: record.content,
      mediaType:
        typeof record.mediaType === "string" ? record.mediaType : "image",
    };
  }
  if (
    typeof record.totalLines === "number" &&
    typeof record.startLine === "number" &&
    typeof record.endLine === "number"
  ) {
    return {
      type: "file",
      content: record.content,
      totalLines: record.totalLines,
      startLine: record.startLine,
      endLine: record.endLine,
    };
  }
  // 没有行号元数据：目录列表（content 每行一个条目）。
  return {
    type: "directory",
    entries: record.content.split("\n").filter((line) => line.length > 0),
  };
};

/** 解析 read 结果（多文件为 { files: [...] } 包装）。 */
const parseReadResult = (raw?: string): ReadResult => {
  if (!raw) return { type: "empty" };
  const record = parseJsonRecord(raw);
  if (!record) return { type: "raw", text: raw };
  if (Array.isArray(record.files)) {
    const files = (record.files as unknown[]).map((file, index) => {
      const item: JsonRecord =
        typeof file === "object" && file !== null && !Array.isArray(file)
          ? (file as JsonRecord)
          : {};
      return {
        filePath:
          typeof item.filePath === "string" ? item.filePath : `file[${index}]`,
        result: parseSingleReadResult(item, formatJson(item)),
      };
    });
    return { type: "multi", files };
  }
  return parseSingleReadResult(record, raw);
};

/** 行范围标签：覆盖全文件显示总行数，否则显示起止行 + 总行数。 */
const rangeLabel = (
  startLine: number,
  endLine: number,
  totalLines: number,
): string =>
  endLine - startLine + 1 >= totalLines
    ? t("remote.toolCall.filesystem.linesTotal", { count: totalLines })
    : t("remote.toolCall.filesystem.lineWindow", {
        start: startLine,
        end: endLine,
        total: totalLines,
      });

/** 单个结果的 meta 文案（文件行范围 / 目录条目数；其它不显示）。 */
const singleRangeLabel = (result: ReadFileResult): string => {
  if (result.type === "file") {
    return rangeLabel(result.startLine, result.endLine, result.totalLines);
  }
  if (result.type === "directory") {
    return t("remote.toolCall.filesystem.entryCount", {
      count: result.entries.length,
    });
  }
  return "";
};

/** read 的 summary 摘要：单文件用文件名，多文件用文件数。 */
const readTitle = (
  args: ReadArgs | null,
  result: ReadResult,
): string | undefined => {
  if (args && !args.isMulti && args.filePath) {
    return fileNameOf(args.filePath);
  }
  const count =
    args?.isMulti && args.paths
      ? args.paths.length
      : result.type === "multi"
        ? result.files.length
        : undefined;
  return count === undefined
    ? undefined
    : t("remote.toolCall.filesystem.fileCount", { count });
};

/**
 * read 的 meta 文案：多文件 / 目录条目数 / 文件行范围（结果未到时退化为参数区间，
 * 参数里的 offset / limit 别名会在这里体现）。
 */
const readMetaLabel = (args: ReadArgs | null, result: ReadResult): string => {
  if (result.type === "multi") {
    return t("remote.toolCall.filesystem.fileCount", {
      count: result.files.length,
    });
  }
  if (result.type === "directory") {
    return t("remote.toolCall.filesystem.entryCount", {
      count: result.entries.length,
    });
  }
  if (result.type === "file") {
    return rangeLabel(result.startLine, result.endLine, result.totalLines);
  }
  if (
    args &&
    !args.isMulti &&
    (args.startLine !== undefined || args.endLine !== undefined)
  ) {
    const start = args.startLine ?? 1;
    const end = args.endLine ?? start;
    return start >= end
      ? t("remote.toolCall.filesystem.lineSingle", { line: start })
      : t("remote.toolCall.filesystem.linesRange", { start, end });
  }
  return "";
};

/** 图片预览（内容可能是 data URL，也可能是 @@image:<src>@@ 包裹的地址）。 */
const imagePreview = (content: string, mediaType: string): HTMLElement => {
  const img = el("img", "tc-image tc-fs-image");
  img.src = content.match(/@@image:([^@]+)@@/)?.[1] ?? content;
  img.alt = t("remote.toolCall.filesystem.imagePreview", { mediaType });
  img.loading = "lazy";
  return img;
};

/** 单个结果的正文（错误 / 目录 / 内容 / 图片 / 原文；空态由调用方处理）。 */
const resultContent = (result: ReadFileResult): Node | null => {
  switch (result.type) {
    case "error":
      return tcErrorRow(result.message);
    case "directory":
      return result.entries.length
        ? entryList(
            result.entries.map((entry) => ({
              icon: entry.endsWith("/") ? "folder" : "file",
              label: entry.endsWith("/") ? entry.slice(0, -1) : entry,
            })),
          )
        : null;
    case "file":
      return contentBlock(result.content);
    case "image":
      return imagePreview(result.content, result.mediaType);
    case "raw":
      return rawResultSection(result.text);
    default:
      return null;
  }
};

/** 多文件结果中的单文件段落：文件名 + 行范围 + 路径 + 内容。 */
const multiFileSection = (file: {
  filePath: string;
  result: ReadFileResult;
}): HTMLElement => {
  const section = el("div", "tc-section");
  const head = el("div", "tc-fs-row");
  const name = el("span", "tc-fs-name", fileNameOf(file.filePath));
  name.title = file.filePath;
  head.append(fileIcon("file"), name);
  const label = singleRangeLabel(file.result);
  if (label) head.append(el("span", "tc-fs-meta", label));
  section.append(head, pathRow(file.filePath));
  const content = resultContent(file.result);
  if (content) section.append(content);
  return section;
};

export const renderReadCard: ToolCallRenderer = (tool) => {
  const raw = tool.arguments;
  const args = parseReadArgs(parseJsonRecord(raw));
  const result = parseReadResult(tool.result);
  // 参数被截断时 parseJsonRecord 拿不到东西，用宽松取串抢救 filePath。
  const filePath = args && !args.isMulti ? args.filePath : undefined;
  const shownPath = filePath ?? recoverPath(raw);

  if (!args && !(raw ?? "").trim() && result.type === "empty") {
    return null; // 无参数也无结果：交给兜底卡
  }

  const body = document.createDocumentFragment();
  if (shownPath) body.append(pathRow(shownPath));

  if (result.type === "multi") {
    for (const file of result.files) body.append(multiFileSection(file));
  } else if (result.type === "empty") {
    if (args?.isMulti && args.paths) {
      // 多文件参数、结果未到达：展示待读取的目标列表。
      body.append(
        entryList(
          args.paths.map((item) => ({ icon: "file", label: item.path })),
        ),
      );
    } else {
      const fallback = argsFallbackSection(parseJsonRecord(raw), raw);
      body.append(
        fallback ?? noteRow(t("remote.toolCall.filesystem.noArguments")),
      );
    }
  } else {
    if (result.type === "file") {
      // 正文统计行：与桌面一致地给出读取到的行窗口（区间也在 header meta 里）。
      body.append(
        noteRow(
          t("remote.toolCall.filesystem.lineWindow", {
            start: result.startLine,
            end: result.endLine,
            total: result.totalLines,
          }),
        ),
      );
    }
    const content = resultContent(result);
    if (content) body.append(content);
    if (isTruncated(tool.result)) {
      body.append(noteRow(t("remote.toolCall.common.truncated"), "warn"));
    }
  }

  const meta: Node[] = [];
  const metaLabel = readMetaLabel(args, result);
  if (metaLabel) meta.push(tcBadge(metaLabel));
  if (isTruncated(tool.result)) {
    meta.push(tcBadge(t("remote.toolCall.common.truncated"), "warn"));
  }

  return withBadgeIcon(
    createToolNode({
      tool,
      status: resolveStatus(tool),
      badge: t("remote.toolCall.filesystem.read"),
      display:
        readTitle(args, result) ??
        (shownPath ? fileNameOf(shownPath) : argsSummary(raw)),
      displayTitle: shownPath,
      meta: meta.length ? meta : undefined,
      body: body.childNodes.length > 0 ? body : undefined,
    }),
    "file",
  );
};

// ── replace_edit ─────────────────────────────────────────────────────────

type EditArgs = {
  filePath: string;
  searchContent: string;
  replaceContent: string;
  occurrence?: number;
};

type EditResult =
  | {
      type: "success";
      matchIndex: number;
      totalMatches: number;
      occurrence: number;
      matchedLineStart?: number;
      matchedLineEnd?: number;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const parseEditArgs = (record: JsonRecord | null): EditArgs | null => {
  if (!record) return null;
  if (typeof record.filePath !== "string" || !record.filePath) return null;
  return {
    filePath: record.filePath,
    searchContent:
      typeof record.searchContent === "string" ? record.searchContent : "",
    replaceContent:
      typeof record.replaceContent === "string" ? record.replaceContent : "",
    occurrence: numberOf(record, "occurrence"),
  };
};

const parseEditResult = (raw?: string): EditResult => {
  if (!raw) return { type: "empty" };
  const record = parseJsonRecord(raw);
  if (!record) return { type: "raw", text: raw };
  if (typeof record.error === "string") {
    return { type: "error", message: record.error };
  }
  if (record.success === true) {
    return {
      type: "success",
      matchIndex: numberOf(record, "matchIndex") ?? 0,
      totalMatches: numberOf(record, "totalMatches") ?? 1,
      occurrence: numberOf(record, "occurrence") ?? 1,
      matchedLineStart: numberOf(record, "matchedLineStart"),
      matchedLineEnd: numberOf(record, "matchedLineEnd"),
    };
  }
  return { type: "raw", text: raw };
};

/** 匹配位置行：行号区间或序号，多个匹配时附 (occurrence/total)。 */
const matchedRow = (result: {
  matchIndex: number;
  totalMatches: number;
  occurrence: number;
  matchedLineStart?: number;
  matchedLineEnd?: number;
}): HTMLElement => {
  const start = result.matchedLineStart;
  const end = result.matchedLineEnd;
  let text: string;
  if (start !== undefined) {
    const lineLabel =
      end !== undefined && end !== start ? `${start}-${end}` : String(start);
    text = t("remote.toolCall.filesystem.matchedLine", { line: lineLabel });
  } else {
    text = t("remote.toolCall.filesystem.matchedIndex", {
      index: result.matchIndex,
    });
  }
  if (result.totalMatches > 1) {
    text += ` (${result.occurrence}/${result.totalMatches})`;
  }
  return successRow(text);
};

export const renderEditCard: ToolCallRenderer = (tool) => {
  const raw = tool.arguments;
  const record = parseJsonRecord(raw);
  const truncated = isTruncated(raw);
  const args = parseEditArgs(record);
  const result = parseEditResult(tool.result);
  const hasError = result.type === "error";
  const shownPath = args?.filePath ?? recoverPath(raw);

  if (!args && !raw && result.type === "empty") return null; // 无参数也无结果：交给兜底卡

  const body = document.createDocumentFragment();
  if (shownPath) body.append(pathRow(shownPath));
  if (hasError) body.append(tcErrorRow(result.message));
  if (args?.occurrence !== undefined) {
    body.append(
      tcKv(t("remote.toolCall.filesystem.occurrence"), String(args.occurrence)),
    );
  }
  if (result.type === "success") body.append(matchedRow(result));

  let meta: Node[] | undefined;
  /*
   * diff 只在参数完整、两侧文本齐备且无错误时渲染：半截参数（搜索 / 替换文本
   * 都是残缺片段）画出来的 diff 会误导，此时改为提示 + 原始参数。
   * replaceContent 允许为空串（整段删除），searchContent 为空则无从对比。
   */
  if (args && !truncated && !hasError && args.searchContent !== "") {
    const lines = computeLineDiff(args.searchContent, args.replaceContent);
    meta = [statsNode(diffStats(lines))];
    body.append(
      diffBlock(
        renderDiffView({
          fileName: fileNameOf(args.filePath),
          oldText: args.searchContent,
          newText: args.replaceContent,
          startLine:
            result.type === "success" ? result.matchedLineStart : undefined,
          lines,
        }),
      ),
    );
  } else if (truncated) {
    body.append(
      noteRow(t("remote.toolCall.filesystem.diffUnavailable"), "warn"),
    );
    if (!hasError) {
      const fallback = argsFallbackSection(record, raw);
      if (fallback) body.append(fallback);
    }
  } else if (!hasError) {
    // 无 diff 可显示：退回参数 JSON 展示（半截 JSON 时退化为原文）。
    const fallback = argsFallbackSection(record, raw);
    if (fallback) body.append(fallback);
  }
  if (result.type === "raw") body.append(rawResultSection(result.text));

  return withBadgeIcon(
    createToolNode({
      tool,
      status: resolveStatus(tool),
      badge: t("remote.toolCall.filesystem.edit"),
      display:
        (shownPath ? fileNameOf(shownPath) : undefined) ?? argsSummary(raw),
      displayTitle: shownPath,
      meta,
      body: body.childNodes.length > 0 ? body : undefined,
    }),
    "file-pen",
  );
};

// ── create ───────────────────────────────────────────────────────────────

type CreateArgs = {
  filePath: string;
  content: string;
  isDirectory: boolean;
  overwrite: boolean;
};

type CreateResult =
  | { type: "success"; path: string }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const parseCreateArgs = (record: JsonRecord | null): CreateArgs | null => {
  if (!record) return null;
  if (typeof record.filePath !== "string" || !record.filePath) return null;
  return {
    filePath: record.filePath,
    content: typeof record.content === "string" ? record.content : "",
    isDirectory: record.isDirectory === true,
    overwrite: record.overwrite === true,
  };
};

const parseCreateResult = (raw?: string): CreateResult => {
  if (!raw) return { type: "empty" };
  const record = parseJsonRecord(raw);
  if (!record) return { type: "raw", text: raw };
  if (typeof record.error === "string") {
    return { type: "error", message: record.error };
  }
  if (record.success === true) {
    return {
      type: "success",
      path: typeof record.path === "string" ? record.path : "",
    };
  }
  return { type: "raw", text: raw };
};

export const renderCreateCard: ToolCallRenderer = (tool) => {
  const raw = tool.arguments;
  const record = parseJsonRecord(raw);
  const truncated = isTruncated(raw);
  const args = parseCreateArgs(record);
  const result = parseCreateResult(tool.result);
  const hasError = result.type === "error";
  const shownPath = args?.filePath ?? recoverPath(raw);
  // 参数被截断时用宽松取串抢救出已到达的内容片段（只作预览，绝不画 diff）。
  const content = args
    ? args.content
    : truncated
      ? (partialString(raw, "content") ?? "")
      : "";

  if (!args && !raw && result.type === "empty") return null; // 无参数也无结果：交给兜底卡

  const body = document.createDocumentFragment();
  if (result.type === "success") {
    body.append(
      successRow(
        t("remote.toolCall.filesystem.created", {
          path: result.path || shownPath || "",
        }),
      ),
    );
  } else if (shownPath) {
    body.append(pathRow(shownPath));
  }
  if (hasError) body.append(tcErrorRow(result.message));
  if (args?.overwrite) {
    body.append(tcKv(t("remote.toolCall.filesystem.overwrite"), "true"));
  }

  const meta: Node[] = [];
  if (args?.isDirectory) {
    meta.push(tcBadge(t("remote.toolCall.filesystem.directory")));
  }

  if (
    args &&
    !truncated &&
    !hasError &&
    !args.isDirectory &&
    args.content !== ""
  ) {
    // 全新增：oldText 为空串，整篇按新增渲染。
    const lines = computeLineDiff("", args.content);
    meta.unshift(statsNode(diffStats(lines)));
    body.append(
      diffBlock(
        renderDiffView({
          fileName: fileNameOf(args.filePath),
          oldText: "",
          newText: args.content,
          lines,
        }),
      ),
    );
  } else if (truncated) {
    body.append(noteRow(t("remote.toolCall.filesystem.argsTruncated"), "warn"));
    if (content !== "") {
      body.append(
        tcSection(
          t("remote.toolCall.filesystem.preview"),
          contentBlock(content),
        ),
      );
    } else {
      const fallback = argsFallbackSection(record, raw);
      if (fallback) body.append(fallback);
    }
  } else if (!hasError) {
    const fallback = argsFallbackSection(record, raw);
    if (fallback) body.append(fallback);
  }
  if (result.type === "raw") body.append(rawResultSection(result.text));

  return withBadgeIcon(
    createToolNode({
      tool,
      status: resolveStatus(tool),
      badge: t("remote.toolCall.filesystem.create"),
      display:
        (shownPath ? fileNameOf(shownPath) : undefined) ?? argsSummary(raw),
      displayTitle: shownPath,
      meta: meta.length ? meta : undefined,
      body: body.childNodes.length > 0 ? body : undefined,
    }),
    "file-plus",
  );
};

// ── 注册表 ───────────────────────────────────────────────────────────────

export const filesystemModule: ToolModule = {
  renderers: {
    "filesystem-read": renderReadCard,
    "filesystem-replace_edit": renderEditCard,
    "filesystem-create": renderCreateCard,
  },
  prefixes: [],
};
