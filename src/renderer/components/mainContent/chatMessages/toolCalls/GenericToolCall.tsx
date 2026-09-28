import { useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  FileCode,
  FileText,
  Layers,
  ListTree,
  Table2,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";
import { getToolCategory, type ToolCategory } from "./shared/ToolNameBadge";
import { JsonTreeView } from "./shared/JsonTreeView";

type GenericToolCallProps = {
  toolCall: ToolCallInfo;
};

type ViewMode = "table" | "tree" | "raw" | "markdown";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const parseJsonSafe = (raw: string | undefined): unknown => {
  if (!raw || raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const truncate = (value: string, max = 56): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

const getFileName = (filePath: string): string =>
  filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;

/** 解码转义字符 */
const decodeEscaped = (text: string): string => {
  if (text.includes("\n") || !text.includes("\\n")) return text;
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
};

/**
 * 结构化表格提取（支持对象数组、二维数组、包装数组或 Markdown 表格）
 */
const extractTableData = (
  value: unknown,
): { columns: string[]; rows: unknown[][] } | null => {
  if (!value) return null;

  // 1. 如果本身是对象数组 [ {...}, {...} ]
  if (Array.isArray(value) && value.length > 0 && isRecord(value[0])) {
    const columns = Object.keys(value[0]);
    const rows = value.map((row) =>
      isRecord(row) ? columns.map((col) => row[col]) : [row],
    );
    return { columns, rows };
  }

  // 2. 如果包含常见包装字段
  if (isRecord(value)) {
    for (const key of [
      "rows",
      "items",
      "records",
      "logs",
      "data",
      "results",
      "candidates",
    ]) {
      const arr = value[key];
      if (Array.isArray(arr) && arr.length > 0) {
        if (isRecord(arr[0])) {
          const columns = Object.keys(arr[0]);
          const rows = arr.map((row) =>
            isRecord(row) ? columns.map((col) => row[col]) : [row],
          );
          return { columns, rows };
        }
      }
    }
  }

  // 3. Markdown 表格字符串解析
  if (
    typeof value === "string" &&
    value.includes("|") &&
    value.includes("\n")
  ) {
    const lines = value
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("|") && l.endsWith("|"));
    if (lines.length >= 2) {
      const splitRow = (l: string) =>
        l
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim());
      const header = splitRow(lines[0]);
      const bodyLines = lines
        .slice(1)
        .filter((l) => !/^\|[\s\-:|]+\|$/.test(l));
      if (header.length > 0) {
        const rows = bodyLines.map(splitRow);
        return { columns: header, rows };
      }
    }
  }

  return null;
};

/**
 * 从外部工具中提取关键参数摘要
 */
const extractGenericSummary = (
  args: Record<string, unknown> | null,
): { label?: string; fullPath?: string } => {
  if (!args) return {};

  // 文件路径优先
  for (const k of ["filePath", "path", "file", "fileName"]) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) {
      return { label: getFileName(v.trim()), fullPath: v.trim() };
    }
  }

  // 服务与关键字（遥测/日志/监控常用）
  const service = asString(args.service);
  const keyword = asString(args.keyword);
  const category = asString(args.category);
  const taskId = asString(args.task_id ?? args.taskId);
  const traceId = asString(args.trace_id ?? args.traceId);

  if (service && keyword) {
    return { label: `${service} · "${keyword}"` };
  }
  if (service) {
    return { label: `service: ${service}` };
  }
  if (keyword) {
    return { label: `"${keyword}"` };
  }
  if (taskId) {
    return { label: `task: ${truncate(taskId, 16)}` };
  }
  if (traceId) {
    return { label: `trace: ${truncate(traceId, 16)}` };
  }
  if (category) {
    return { label: `category: ${category}` };
  }

  // URL / 检索 / SQL
  const url = asString(args.url);
  if (url) return { label: truncate(url, 40) };

  const sql = asString(args.sql);
  if (sql) return { label: truncate(sql.replace(/\s+/g, " "), 40) };

  const query = asString(args.query);
  if (query) return { label: `"${truncate(query, 32)}"` };

  const command = asString(args.command);
  if (command) return { label: truncate(command, 32) };

  const name = asString(args.name);
  if (name) return { label: name };

  return {};
};

/** 单元格文字截断格式化 */
const formatCell = (val: unknown): string => {
  if (val === null || val === undefined) return "—";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "object") {
    try {
      return truncate(JSON.stringify(val), 60);
    } catch {
      return "[Object]";
    }
  }
  return truncate(String(val), 60);
};

export const GenericToolCall = ({
  toolCall,
}: GenericToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const parsedArgs = useMemo(() => {
    const res = parseJsonSafe(toolCall.arguments);
    return isRecord(res) ? res : null;
  }, [toolCall.arguments]);

  const parsedResult = useMemo(
    () => parseJsonSafe(toolCall.result),
    [toolCall.result],
  );

  // 表格探测
  const tableData = useMemo(() => {
    return extractTableData(parsedResult);
  }, [parsedResult]);

  // Markdown 长文本探测
  const markdownText = useMemo(() => {
    if (typeof parsedResult === "string" && parsedResult.length > 80) {
      return decodeEscaped(parsedResult);
    }
    if (isRecord(parsedResult)) {
      for (const k of [
        "markdown",
        "content",
        "text",
        "body",
        "summary",
        "description",
      ]) {
        const v = parsedResult[k];
        if (typeof v === "string" && v.length > 80) {
          return decodeEscaped(v);
        }
      }
    }
    return null;
  }, [parsedResult]);

  // 默认视图模式：有表格优选 table，有 Markdown 优选 markdown，否则 tree
  const defaultMode: ViewMode = tableData
    ? "table"
    : markdownText
      ? "markdown"
      : isRecord(parsedResult) || Array.isArray(parsedResult)
        ? "tree"
        : "raw";

  const [mode, setMode] = useState<ViewMode>(defaultMode);

  // 类别与图标
  const category: ToolCategory = useMemo(
    () => getToolCategory(toolCall.name),
    [toolCall.name],
  );

  // 参数摘要
  const { label: argsLabel, fullPath } = useMemo(
    () => extractGenericSummary(parsedArgs),
    [parsedArgs],
  );

  // 状态与结果判定
  const hasError = useMemo(() => {
    if (toolCall.status === "error") return true;
    if (isRecord(parsedResult) && typeof parsedResult.error === "string")
      return true;
    return false;
  }, [toolCall.status, parsedResult]);

  const effectiveStatus = hasError ? "error" : toolCall.status;

  // Header 胶囊元数据 Pills（对标函数调用关系等现代化卡片）
  const metaPills = useMemo(() => {
    if (toolCall.status === "running") return null;

    if (hasError) {
      const errMsg =
        isRecord(parsedResult) && typeof parsedResult.error === "string"
          ? parsedResult.error
          : undefined;
      return (
        <span className="tool-call-codelens-count tool-call-codelens-count-error">
          <AlertCircle size={10} aria-hidden="true" />
          {truncate(
            errMsg || t("toolCall.common.error", { defaultValue: "执行异常" }),
            24,
          )}
        </span>
      );
    }

    if (!parsedResult) return null;

    // 1. 如果是遥测/诊断结果（包含 activeErrors, errors, issues 等）
    if (isRecord(parsedResult)) {
      const errCount =
        typeof parsedResult.activeErrors === "number"
          ? parsedResult.activeErrors
          : Array.isArray(parsedResult.errors)
            ? parsedResult.errors.length
            : Array.isArray(parsedResult.diagnose)
              ? parsedResult.diagnose.length
              : undefined;

      if (errCount !== undefined) {
        return (
          <span
            className={`tool-call-codelens-count ${
              errCount > 0
                ? "tool-call-codelens-count-error"
                : "tool-call-codelens-count-ok"
            }`}
          >
            {errCount === 0 ? (
              <CheckCircle2 size={10} aria-hidden="true" />
            ) : (
              <AlertCircle size={10} aria-hidden="true" />
            )}
            {errCount === 0
              ? t("toolCall.generic.noErrors", { defaultValue: "0 活跃故障" })
              : t("toolCall.generic.errorCount", {
                  values: { count: errCount },
                  defaultValue: `${errCount} 个异常`,
                })}
          </span>
        );
      }
    }

    // 2. 如果解析到了表格
    if (tableData) {
      return (
        <span className="tool-call-codelens-count tool-call-codelens-count-info">
          <Table2 size={10} aria-hidden="true" />
          {t("toolCall.generic.rowCount", {
            values: { count: tableData.rows.length },
            defaultValue: `${tableData.rows.length} 行`,
          })}
        </span>
      );
    }

    // 3. 数组项计数
    if (Array.isArray(parsedResult)) {
      return (
        <span className="tool-call-codelens-count tool-call-codelens-count-info">
          <Layers size={10} aria-hidden="true" />
          {t("toolCall.generic.itemCount", {
            values: { count: parsedResult.length },
            defaultValue: `${parsedResult.length} 条记录`,
          })}
        </span>
      );
    }

    // 4. 包含特定 status
    if (isRecord(parsedResult) && typeof parsedResult.status === "string") {
      const s = parsedResult.status;
      return (
        <span className="tool-call-codelens-count tool-call-codelens-count-ok">
          <CheckCircle2 size={10} aria-hidden="true" />
          {s}
        </span>
      );
    }

    // 5. 字符数统计
    if (markdownText) {
      return (
        <span className="tool-call-codelens-count tool-call-codelens-count-muted">
          <FileText size={10} aria-hidden="true" />
          {t("toolCall.common.charCount", {
            values: { count: markdownText.length.toLocaleString() },
            defaultValue: `${markdownText.length} 字符`,
          })}
        </span>
      );
    }

    return null;
  }, [toolCall.status, hasError, parsedResult, tableData, markdownText, t]);

  const handleCopyResult = (e: React.MouseEvent) => {
    e.stopPropagation();
    const text =
      typeof parsedResult === "string"
        ? parsedResult
        : JSON.stringify(parsedResult, null, 2);
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const hasBody = Boolean(toolCall.arguments || toolCall.result);

  return (
    <ToolCallNode
      toolName={toolCall.name}
      category={category}
      status={effectiveStatus}
      displayName={argsLabel}
      displayNameTitle={fullPath || toolCall.arguments}
      displayNameDataPath={fullPath}
      meta={metaPills}
      lazyBody
    >
      {hasBody ? (
        <div className="tool-call-generic-body">
          {/* 参数区域 */}
          {parsedArgs && Object.keys(parsedArgs).length > 0 ? (
            <div className="tool-call-generic-section">
              <span className="tool-call-section-label">
                {t("toolCall.common.arguments")}
              </span>
              <pre className="tool-call-section-pre tool-call-generic-pre">
                {JSON.stringify(parsedArgs, null, 2)}
              </pre>
            </div>
          ) : null}

          {/* 结果区域 */}
          {toolCall.result ? (
            <div className="tool-call-generic-section">
              <div className="tool-call-generic-toolbar">
                <span className="tool-call-section-label">
                  {t("toolCall.common.result")}
                </span>

                <div className="tool-call-generic-view-tabs">
                  {tableData && (
                    <button
                      type="button"
                      className={`tool-call-generic-tab ${mode === "table" ? "active" : ""}`}
                      onClick={() => setMode("table")}
                    >
                      <Table2 size={11} aria-hidden="true" />
                      {t("toolCall.generic.table", { defaultValue: "表格" })}
                    </button>
                  )}
                  {markdownText && (
                    <button
                      type="button"
                      className={`tool-call-generic-tab ${mode === "markdown" ? "active" : ""}`}
                      onClick={() => setMode("markdown")}
                    >
                      <FileText size={11} aria-hidden="true" />
                      {t("toolCall.generic.markdown", { defaultValue: "文档" })}
                    </button>
                  )}
                  {(isRecord(parsedResult) || Array.isArray(parsedResult)) && (
                    <button
                      type="button"
                      className={`tool-call-generic-tab ${mode === "tree" ? "active" : ""}`}
                      onClick={() => setMode("tree")}
                    >
                      <ListTree size={11} aria-hidden="true" />
                      {t("toolCall.generic.tree", { defaultValue: "JSON 树" })}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`tool-call-generic-tab ${mode === "raw" ? "active" : ""}`}
                    onClick={() => setMode("raw")}
                  >
                    <FileCode size={11} aria-hidden="true" />
                    {t("toolCall.generic.raw", { defaultValue: "原始" })}
                  </button>
                </div>

                <div className="tool-call-generic-actions">
                  <button
                    type="button"
                    className="tool-call-lsp-copy-btn"
                    onClick={handleCopyResult}
                    title={
                      copied
                        ? t("toolCall.generic.copied", {
                            defaultValue: "已复制",
                          })
                        : t("toolCall.generic.copy", {
                            defaultValue: "复制结果",
                          })
                    }
                  >
                    {copied ? (
                      <Check size={12} className="copy-ok" />
                    ) : (
                      <Copy size={12} />
                    )}
                  </button>
                </div>
              </div>

              {/* 渲染对应视图 */}
              <div className="tool-call-generic-content">
                {mode === "table" && tableData ? (
                  <div className="tool-call-generic-table-wrapper">
                    <table className="tool-call-generic-table">
                      <thead>
                        <tr>
                          <th className="tool-call-generic-th-index">#</th>
                          {tableData.columns.map((col, i) => (
                            <th key={i} title={col}>
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {tableData.rows.slice(0, 100).map((row, rowIdx) => (
                          <tr key={rowIdx}>
                            <td className="tool-call-generic-td-index">
                              {rowIdx + 1}
                            </td>
                            {tableData.columns.map((_, colIdx) => {
                              const cellValue = row[colIdx];
                              const formatted = formatCell(cellValue);
                              return (
                                <td
                                  key={colIdx}
                                  title={String(cellValue ?? "")}
                                >
                                  {formatted}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {tableData.rows.length > 100 && (
                      <div className="tool-call-generic-table-more">
                        {t("toolCall.generic.truncated", {
                          values: { total: tableData.rows.length, shown: 100 },
                          defaultValue: `已显示前 100 条（共 ${tableData.rows.length} 条）`,
                        })}
                      </div>
                    )}
                  </div>
                ) : mode === "markdown" && markdownText ? (
                  <div className="tool-call-generic-markdown">
                    {markdownText.split("\n\n").map((paragraph, pIdx) => (
                      <p key={pIdx}>{paragraph}</p>
                    ))}
                  </div>
                ) : mode === "tree" &&
                  (isRecord(parsedResult) || Array.isArray(parsedResult)) ? (
                  <div className="tool-call-generic-tree-wrapper">
                    <JsonTreeView
                      data={parsedResult}
                      defaultExpandDepth={2}
                      longStringThreshold={120}
                    />
                  </div>
                ) : (
                  <pre className="tool-call-section-pre tool-call-generic-pre">
                    {typeof parsedResult === "string"
                      ? decodeEscaped(parsedResult)
                      : JSON.stringify(parsedResult, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </ToolCallNode>
  );
};
