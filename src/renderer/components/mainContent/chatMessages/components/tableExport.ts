/**
 * Markdown 表格导出。
 *
 * 渲染层从 DOM 提取表格二维数据（行 × 列的文本矩阵），交给 Rust 生成
 * CSV / XLSX 文件字节（见 IPC `chat-conversations:export-table`），
 * 主进程弹出保存对话框并写入用户选择的路径 —— 与「导出会话」同一条链路。
 */

/** 表格可导出的文件格式。 */
type TableExportFormat = "csv" | "xlsx";

/**
 * 提取表格数据：遍历 DOM 行与单元格，单元格内空白（含 <br> 产生的换行）
 * 压缩为单个空格；colspan 展开为空单元格，保证每行列数一致。
 */
const extractTableRows = (table: HTMLTableElement): string[][] => {
  const rows: string[][] = [];
  for (const row of Array.from(table.rows)) {
    const cells: string[] = [];
    for (const cell of Array.from(row.cells)) {
      const text = (cell.textContent ?? "").replace(/\s+/g, " ").trim();
      cells.push(text);
      const span = Math.max(cell.colSpan, 1);
      for (let i = 1; i < span; i += 1) {
        cells.push("");
      }
    }
    rows.push(cells);
  }
  return rows;
};

/** 默认文件名：table-20260914-153012（本地时间）。 */
const buildDefaultFileName = (): string => {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `table-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
};

/** 导出表格：Rust 生成文件字节，主进程弹出保存对话框写盘。 */
export const exportTable = async (
  table: HTMLTableElement,
  format: TableExportFormat,
): Promise<void> => {
  const rows = extractTableRows(table);
  if (rows.length === 0) {
    return;
  }
  await window.snow.exportMarkdownTable(
    format,
    JSON.stringify(rows),
    buildDefaultFileName(),
  );
};

/**
 * 在下载按钮下方打开格式选择菜单（CSV / XLSX）。
 *
 * 菜单挂在 body 上以脱离消息容器（避免被 overflow / transform 裁剪），
 * 点击菜单项立即导出，点击外部或按 Esc 关闭。
 */
export const openTableExportMenu = (
  anchorEl: HTMLElement,
  table: HTMLTableElement,
): void => {
  // 单例：移除已打开的菜单。
  document.querySelectorAll(".table-export-menu").forEach((el) => el.remove());

  const menu = document.createElement("div");
  menu.className = "table-export-menu";

  const formats: { format: TableExportFormat; label: string }[] = [
    { format: "csv", label: "CSV" },
    { format: "xlsx", label: "XLSX" },
  ];

  for (const { format, label } of formats) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "table-export-menu-item";
    item.textContent = label;
    item.addEventListener("click", () => {
      menu.remove();
      void exportTable(table, format).catch((error) => {
        console.error("[markdown] export table failed:", error);
      });
    });
    menu.appendChild(item);
  }

  // 定位到按钮下方，右边缘与按钮对齐。
  const rect = anchorEl.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.right}px`;
  menu.style.transform = "translateX(-100%)";

  document.body.appendChild(menu);

  const close = (): void => {
    menu.remove();
    document.removeEventListener("mousedown", dismiss, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const dismiss = (e: MouseEvent): void => {
    if (menu.contains(e.target as Node)) return;
    close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      close();
    }
  };

  // 关闭处理在下一个任务挂载，避免打开菜单的这次点击立刻触发关闭。
  setTimeout(() => {
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
};
