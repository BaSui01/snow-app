import { Loader2 } from "lucide-react";

import type { FilePreviewResult } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { PreviewDataGrid } from "./PreviewDataGrid";

type SpreadsheetPreviewProps = {
  preview: FilePreviewResult;
  activeSection: string;
  loadingSection: string | null;
  onSelectSection: (name: string) => void;
};

/** 工作簿预览：工作表页签 + 单元格表格（值与合并区域），截断时明确标注。 */
export function SpreadsheetPreview({
  preview,
  activeSection,
  loadingSection,
  onSelectSection,
}: SpreadsheetPreviewProps): React.JSX.Element {
  const { t } = useI18n();
  const grid = preview.grid ?? null;

  return (
    <div className="file-preview-sheet">
      <div className="file-preview-tabs" role="tablist">
        {preview.sheets.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={name === activeSection}
            className={`file-preview-tab${
              name === activeSection ? " active" : ""
            }`}
            onClick={() => onSelectSection(name)}
            disabled={loadingSection != null}
            title={name}
          >
            {loadingSection === name ? (
              <Loader2 className="spin" size={11} />
            ) : null}
            <span>{name}</span>
          </button>
        ))}
      </div>
      {preview.gridError ? (
        <div className="file-preview-inline-error">
          <span>{t("rightPanel.filePreview.sectionFailed")}</span>
          <pre>{preview.gridError}</pre>
        </div>
      ) : grid && grid.rows.length > 0 ? (
        <PreviewDataGrid grid={grid} mode="sheet" />
      ) : (
        <div className="file-preview-empty">
          {t("rightPanel.filePreview.emptySheet")}
        </div>
      )}
      {grid ? (
        <div className="file-preview-status">
          <span>
            {t("rightPanel.filePreview.gridSize", {
              values: { rows: grid.totalRows, columns: grid.totalColumns },
            })}
          </span>
          {grid.truncatedRows ? (
            <span className="file-preview-status-warn">
              {t("rightPanel.filePreview.truncatedRows", {
                values: { count: grid.rows.length },
              })}
            </span>
          ) : null}
          {grid.truncatedColumns ? (
            <span className="file-preview-status-warn">
              {t("rightPanel.filePreview.truncatedColumns", {
                values: { count: grid.rows[0]?.length ?? 0 },
              })}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
