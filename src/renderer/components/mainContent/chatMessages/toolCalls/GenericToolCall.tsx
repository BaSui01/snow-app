import { useMemo, useState } from "react";
import { AlertCircle, Check, Copy } from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";
import { getToolCategory } from "./shared/ToolNameBadge";
import { ToolResultView } from "./shared/ToolResultView";
import { DataTableViewer } from "./shared/DataTableViewer";

type GenericToolCallProps = {
  toolCall: ToolCallInfo;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonSafe = (raw: string | undefined): unknown => {
  if (raw === undefined || raw === "") return undefined;
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

const extractGenericSummary = (
  args: Record<string, unknown>,
): { label?: string; fullPath?: string } => {
  for (const key of ["filePath", "path", "file", "fileName"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return { label: getFileName(value.trim()), fullPath: value.trim() };
    }
  }

  for (const key of [
    "query",
    "command",
    "url",
    "name",
    "service",
    "keyword",
    "task_id",
    "taskId",
    "trace_id",
    "traceId",
    "category",
    "sql",
  ]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return { label: truncate(value.trim()) };
    }
  }

  return {};
};

type Translate = ReturnType<typeof useI18n>["t"];
type TableData = { columns: string[]; rows: unknown[][] };

/** Only the optional preview unwraps MCP payloads; full details retain the envelope. */
const getPreviewPayload = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const payload = isRecord(value.result) ? value.result : value;
  if (!Array.isArray(payload.content)) return payload;
  const text = payload.content
    .filter(
      (block) =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => (block as Record<string, unknown>).text as string)
    .join("\n");
  if (text.length > 256 * 1024 && /^\s*[\[{]/.test(text)) return undefined;
  return text ? parseJsonSafe(text) : payload;
};

/** Complex cells stay in the complete structured view, never JSON source in a table. */
const isScalarCell = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && !/^\s*[\[{]/.test(value)) ||
  typeof value === "number" ||
  typeof value === "boolean";

const extractTableData = (value: unknown, t: Translate): TableData | null => {
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
      if (Array.isArray(value[key]) && value[key].length > 0) {
        const table = extractTableData(value[key], t);
        if (table) return table;
      }
    }
    return null;
  }
  if (Array.isArray(value) && value.length > 0) {
    if (value.every(isRecord)) {
      if (!value.every((row) => Object.values(row).every(isScalarCell)))
        return null;
      const columns = [...new Set(value.flatMap((row) => Object.keys(row)))];
      if (columns.length === 0) return null;
      return {
        columns,
        rows: value.map((row) =>
          columns.map((column) =>
            Object.prototype.hasOwnProperty.call(row, column)
              ? row[column]
              : undefined,
          ),
        ),
      };
    }
    if (value.every(Array.isArray)) {
      if (!value.every((row) => row.every(isScalarCell))) return null;
      const width = value.reduce((max, row) => Math.max(max, row.length), 0);
      if (width === 0) return null;
      return {
        columns: Array.from({ length: width }, (_, index) =>
          t("toolResults.column", { values: { index: index + 1 } }),
        ),
        rows: value,
      };
    }
  }
  if (typeof value === "string" && isScalarCell(value) && value.includes("|")) {
    const lines = value.split("\n").map((line) => line.trim());
    const headerIndex = lines.findIndex(
      (line, index) =>
        line.startsWith("|") &&
        line.endsWith("|") &&
        /^\|[\s\-:|]+\|$/.test(lines[index + 1] ?? ""),
    );
    if (headerIndex >= 0) {
      const splitRow = (line: string) =>
        line
          .slice(1, -1)
          .split("|")
          .map((cell) => cell.trim());
      const rows: string[][] = [];
      for (const line of lines.slice(headerIndex + 2)) {
        if (!line.startsWith("|") || !line.endsWith("|")) break;
        rows.push(splitRow(line));
      }
      if (!rows.every((row) => row.every(isScalarCell))) return null;
      return { columns: splitRow(lines[headerIndex]), rows };
    }
  }
  return null;
};

const extractDocumentText = (value: unknown): string | null => {
  if (typeof value === "string" && isScalarCell(value) && value.length > 80)
    return value;
  if (isRecord(value)) {
    for (const key of [
      "markdown",
      "content",
      "text",
      "body",
      "summary",
      "description",
    ]) {
      const text = value[key];
      if (typeof text === "string" && isScalarCell(text) && text.length > 80)
        return text;
    }
  }
  return null;
};

const ResultPreview = ({
  value,
}: {
  value: unknown;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const payload = useMemo(() => getPreviewPayload(value), [value]);
  const table = useMemo(() => extractTableData(payload, t), [payload, t]);
  const documentText = useMemo(
    () => (table ? null : extractDocumentText(payload)),
    [payload, table],
  );
  if (!table && !documentText) return null;

  return (
    <details
      className="tool-result-preview"
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setExpanded(event.currentTarget.open);
      }}
    >
      <summary className="tool-result-summary">
        {t(table ? "toolResults.tablePreview" : "toolResults.documentPreview")}
      </summary>
      {expanded ? (
        <div className="tool-result-preview-content">
          {table ? (
            <DataTableViewer
              columns={table.columns}
              rows={table.rows}
              maxInitialRows={40}
              className="tool-result-table-preview"
            />
          ) : (
            <div className="tool-result-document-preview">{documentText}</div>
          )}
        </div>
      ) : null}
    </details>
  );
};

const CopyResultButton = ({ value }: { value: string }): React.JSX.Element => {
  const { t } = useI18n();
  const [outcome, setOutcome] = useState<"idle" | "copied" | "error">("idle");
  const label = t(
    outcome === "copied"
      ? "toolResults.copied"
      : outcome === "error"
        ? "toolResults.copyFailed"
        : "toolResults.copy",
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setOutcome("copied");
    } catch {
      setOutcome("error");
    }
  };
  return (
    <button
      type="button"
      className={`tool-result-button tool-result-copy${outcome === "error" ? " tool-result-copy-error" : ""}`}
      onClick={copy}
      title={label}
    >
      {outcome === "copied" ? (
        <Check size={12} aria-hidden="true" />
      ) : outcome === "error" ? (
        <AlertCircle size={12} aria-hidden="true" />
      ) : (
        <Copy size={12} aria-hidden="true" />
      )}
      <span aria-live="polite">{label}</span>
    </button>
  );
};

export const GenericToolCall = ({
  toolCall,
}: GenericToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const parsedArgs = useMemo(
    () => parseJsonSafe(toolCall.arguments),
    [toolCall.arguments],
  );
  const parsedResult = useMemo(
    () => parseJsonSafe(toolCall.result),
    [toolCall.result],
  );
  const { label, fullPath } = useMemo(
    () => (isRecord(parsedArgs) ? extractGenericSummary(parsedArgs) : {}),
    [parsedArgs],
  );
  const category = useMemo(
    () => getToolCategory(toolCall.name),
    [toolCall.name],
  );
  const hasArguments =
    toolCall.arguments !== undefined && toolCall.arguments !== "";
  const hasResult = toolCall.result !== undefined && toolCall.result !== "";

  return (
    <ToolCallNode
      toolName={toolCall.name}
      category={category}
      status={toolCall.status}
      displayName={label}
      displayNameTitle={fullPath || label}
      displayNameDataPath={fullPath}
      lazyBody
    >
      {hasArguments || hasResult ? (
        <div className="tool-result-sections">
          {hasArguments ? (
            <section className="tool-result-section">
              <h4 className="tool-result-section-label">
                {t("toolResults.arguments")}
              </h4>
              <ToolResultView value={parsedArgs} />
            </section>
          ) : null}
          {hasResult ? (
            <section className="tool-result-section">
              <div className="tool-result-toolbar">
                <h4 className="tool-result-section-label">
                  {t("toolResults.result")}
                </h4>
                <CopyResultButton
                  key={toolCall.result}
                  value={toolCall.result!}
                />
              </div>
              <ResultPreview value={parsedResult} />
              <ToolResultView value={parsedResult} />
            </section>
          ) : null}
        </div>
      ) : null}
    </ToolCallNode>
  );
};
