import { useMemo, useRef } from "react";

import type { PreviewGrid, PreviewMerge } from "../../../../preload";
import { useVirtualRows } from "./useVirtualRows";

/** 行高固定：虚拟窗口按行高计算可见区间，单元格单行省略显示。 */
const ROW_HEIGHT = 24;
const ROW_HEADER_WIDTH = 52;
const COLUMN_WIDTH = 140;

type PreviewDataGridProps = {
  grid: PreviewGrid;
  /** sheet：列头为字母、行号取工作表绝对行；table：列头为字段名、空值显示 NULL。 */
  mode: "sheet" | "table";
};

/** 列号转 Excel 列字母（0 -> A，26 -> AA）。 */
const columnLetter = (index: number): string => {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
};

const cellKey = (row: number, column: number): string => `${row}:${column}`;

/** 只读表格：粘性表头与行号列、固定列宽、按行虚拟化，支持合并单元格。 */
export function PreviewDataGrid({
  grid,
  mode,
}: PreviewDataGridProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowCount = grid.rows.length;
  const columnCount =
    mode === "table" ? grid.headers.length : (grid.rows[0]?.length ?? 0);
  const { range } = useVirtualRows(scrollRef, rowCount, ROW_HEIGHT);

  // 合并区域索引：锚点单元格 -> 区域；被覆盖的单元格 -> 所属区域。
  const merges = useMemo(() => {
    const anchors = new Map<string, PreviewMerge>();
    const covered = new Map<string, PreviewMerge>();
    for (const merge of grid.merges) {
      anchors.set(cellKey(merge.row, merge.column), merge);
      for (let row = merge.row; row < merge.row + merge.rowSpan; row += 1) {
        for (
          let column = merge.column;
          column < merge.column + merge.columnSpan;
          column += 1
        ) {
          if (row !== merge.row || column !== merge.column) {
            covered.set(cellKey(row, column), merge);
          }
        }
      }
    }
    return { anchors, covered };
  }, [grid.merges]);

  const headers = useMemo(
    () =>
      Array.from({ length: columnCount }, (_, index) =>
        mode === "table"
          ? grid.headers[index]
          : columnLetter(grid.columnOffset + index),
      ),
    [columnCount, grid.columnOffset, grid.headers, mode],
  );

  const renderCell = (
    value: string | null | undefined,
    key: string,
    rowSpan = 1,
    columnSpan = 1,
  ): React.JSX.Element => {
    const isNull = mode === "table" && value == null;
    return (
      <td
        key={key}
        rowSpan={rowSpan > 1 ? rowSpan : undefined}
        colSpan={columnSpan > 1 ? columnSpan : undefined}
        className={isNull ? "file-preview-grid-null" : undefined}
        title={value ?? undefined}
      >
        {isNull ? "NULL" : (value ?? "")}
      </td>
    );
  };

  const renderRow = (rowIndex: number): React.JSX.Element => {
    const cells: React.JSX.Element[] = [];
    const row = grid.rows[rowIndex] ?? [];
    for (let column = 0; column < columnCount; column += 1) {
      const key = cellKey(rowIndex, column);
      const anchor = merges.anchors.get(key);
      if (anchor) {
        cells.push(
          renderCell(
            row[column],
            key,
            Math.min(anchor.rowSpan, range.end - rowIndex),
            anchor.columnSpan,
          ),
        );
        continue;
      }
      const owner = merges.covered.get(key);
      if (owner) {
        // 合并区域的锚点行已滚出窗口：在首个可见行补画被裁剪的合并单元格。
        if (
          rowIndex === range.start &&
          owner.row < range.start &&
          column === owner.column
        ) {
          cells.push(
            renderCell(
              grid.rows[owner.row]?.[owner.column],
              key,
              Math.min(owner.row + owner.rowSpan, range.end) - range.start,
              owner.columnSpan,
            ),
          );
        }
        continue;
      }
      cells.push(renderCell(row[column], key));
    }
    return (
      <tr key={rowIndex}>
        <th className="file-preview-grid-row-header" scope="row">
          {mode === "sheet" ? grid.rowOffset + rowIndex + 1 : rowIndex + 1}
        </th>
        {cells}
      </tr>
    );
  };

  const visibleRows: React.JSX.Element[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    visibleRows.push(renderRow(index));
  }
  const topSpacer = range.start * ROW_HEIGHT;
  const bottomSpacer = Math.max(0, rowCount - range.end) * ROW_HEIGHT;

  return (
    <div className="file-preview-grid-scroll" ref={scrollRef}>
      <table
        className="file-preview-grid"
        style={{ width: ROW_HEADER_WIDTH + columnCount * COLUMN_WIDTH }}
      >
        <colgroup>
          <col style={{ width: ROW_HEADER_WIDTH }} />
          {headers.map((header, index) => (
            <col key={`${index}:${header}`} style={{ width: COLUMN_WIDTH }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="file-preview-grid-corner" />
            {headers.map((header, index) => (
              <th key={`${index}:${header}`} scope="col" title={header}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {topSpacer > 0 ? (
            <tr
              className="file-preview-grid-spacer"
              style={{ height: topSpacer }}
            >
              <td colSpan={columnCount + 1} />
            </tr>
          ) : null}
          {visibleRows}
          {bottomSpacer > 0 ? (
            <tr
              className="file-preview-grid-spacer"
              style={{ height: bottomSpacer }}
            >
              <td colSpan={columnCount + 1} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
