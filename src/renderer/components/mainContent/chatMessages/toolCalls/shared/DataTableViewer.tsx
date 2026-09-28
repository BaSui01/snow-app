import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Download,
  Search,
} from "lucide-react";
import { useI18n } from "../../../../../i18n";

type DataTableViewerProps = {
  columns: string[];
  rows: unknown[][];
  maxInitialRows?: number;
  className?: string;
  enableExport?: boolean;
  enableSearch?: boolean;
};

/** 单元格文字截断与格式化 */
const formatCell = (val: unknown, maxChars = 80): string => {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "object") {
    try {
      const json = JSON.stringify(val);
      return json.length > maxChars ? `${json.slice(0, maxChars)}...` : json;
    } catch {
      return "[Object]";
    }
  }
  const str = String(val);
  return str.length > maxChars ? `${str.slice(0, maxChars)}...` : str;
};

export const DataTableViewer = ({
  columns,
  rows,
  maxInitialRows = 100,
  className = "",
  enableExport = true,
  enableSearch = true,
}: DataTableViewerProps): React.JSX.Element => {
  const { t } = useI18n();
  const [searchTerm, setSearchTerm] = useState("");
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [csvCopied, setCsvCopied] = useState(false);
  const [showAllRows, setShowAllRows] = useState(false);

  // 过滤与排序
  const processedRows = useMemo(() => {
    let result = rows;

    if (searchTerm.trim()) {
      const query = searchTerm.toLowerCase();
      result = result.filter((row) =>
        row.some((cell) =>
          String(cell ?? "")
            .toLowerCase()
            .includes(query),
        ),
      );
    }

    if (sortCol !== null && sortCol < columns.length) {
      result = [...result].sort((a, b) => {
        const valA = a[sortCol];
        const valB = b[sortCol];
        if (typeof valA === "number" && typeof valB === "number") {
          return sortAsc ? valA - valB : valB - valA;
        }
        return sortAsc
          ? String(valA ?? "").localeCompare(String(valB ?? ""))
          : String(valB ?? "").localeCompare(String(valA ?? ""));
      });
    }

    return result;
  }, [rows, searchTerm, sortCol, sortAsc, columns.length]);

  const displayedRows = useMemo(() => {
    if (showAllRows) return processedRows;
    return processedRows.slice(0, maxInitialRows);
  }, [processedRows, showAllRows, maxInitialRows]);

  const handleExportCsv = (e: React.MouseEvent) => {
    e.stopPropagation();
    const header = columns.map((c) => JSON.stringify(c)).join(",");
    const body = processedRows.map((r) =>
      r.map((c) => JSON.stringify(c ?? "")).join(","),
    );
    const csv = [header, ...body].join("\n");
    navigator.clipboard.writeText(csv);
    setCsvCopied(true);
    setTimeout(() => setCsvCopied(false), 1500);
  };

  return (
    <div className={`data-table-viewer ${className}`}>
      {/* 表格操作工具条 */}
      {(enableSearch || enableExport) && (
        <div className="data-table-toolbar">
          {enableSearch && (
            <div className="data-table-search-box">
              <Search size={11} aria-hidden="true" />
              <input
                type="text"
                className="data-table-search-input"
                placeholder={t("common.filterTable", {
                  defaultValue: "过滤表格内容...",
                })}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          )}

          <div className="data-table-toolbar-right">
            <span className="data-table-row-counter">
              {processedRows.length === rows.length
                ? `${rows.length} 行`
                : `${processedRows.length} / ${rows.length} 行`}
            </span>

            {enableExport && (
              <button
                type="button"
                className="data-table-export-btn"
                onClick={handleExportCsv}
                title="导出为 CSV 文本到剪贴板"
              >
                {csvCopied ? (
                  <Check size={11} aria-hidden="true" />
                ) : (
                  <Download size={11} aria-hidden="true" />
                )}
                <span>{csvCopied ? "已复制 CSV" : "导出 CSV"}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 表格主体 */}
      <div className="data-table-scroll-container">
        <table className="data-table-grid">
          <thead>
            <tr>
              <th className="data-table-th-index">#</th>
              {columns.map((col, i) => (
                <th
                  key={i}
                  title={`点击排序: ${col}`}
                  className="data-table-th-sortable"
                  onClick={() => {
                    if (sortCol === i) {
                      if (sortAsc) {
                        setSortAsc(false);
                      } else {
                        setSortCol(null);
                        setSortAsc(true);
                      }
                    } else {
                      setSortCol(i);
                      setSortAsc(true);
                    }
                  }}
                >
                  <span>{col}</span>
                  {sortCol === i ? (
                    sortAsc ? (
                      <ArrowUp size={10} aria-hidden="true" />
                    ) : (
                      <ArrowDown size={10} aria-hidden="true" />
                    )
                  ) : (
                    <ArrowUpDown
                      size={10}
                      className="sort-idle"
                      aria-hidden="true"
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayedRows.map((row, rowIdx) => (
              <tr key={rowIdx}>
                <td className="data-table-td-index">{rowIdx + 1}</td>
                {columns.map((_, colIdx) => {
                  const cellValue = row[colIdx];
                  const formatted = formatCell(cellValue);
                  const isNull = cellValue === null || cellValue === undefined;
                  return (
                    <td
                      key={colIdx}
                      title={String(cellValue ?? "")}
                      className={isNull ? "data-table-cell-null" : undefined}
                    >
                      {formatted}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 展开全部或截断提示 */}
      {processedRows.length > maxInitialRows && (
        <div className="data-table-pagination-bar">
          <span>
            {showAllRows
              ? `已显示全部 ${processedRows.length} 条记录`
              : `已显示前 ${maxInitialRows} 条（共 ${processedRows.length} 条）`}
          </span>
          <button
            type="button"
            className="data-table-toggle-rows-btn"
            onClick={() => setShowAllRows((v) => !v)}
          >
            {showAllRows ? "收起部分" : "展开全部"}
          </button>
        </div>
      )}
    </div>
  );
};
