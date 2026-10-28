import { KeyRound, Loader2, Table2, View } from "lucide-react";

import type { FilePreviewResult } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { PreviewDataGrid } from "./PreviewDataGrid";

type DatabasePreviewProps = {
  preview: FilePreviewResult;
  activeSection: string;
  loadingSection: string | null;
  onSelectSection: (name: string) => void;
};

/** SQLite 预览：表/视图清单 + 列结构 + 前 N 行数据（只读）。 */
export function DatabasePreview({
  preview,
  activeSection,
  loadingSection,
  onSelectSection,
}: DatabasePreviewProps): React.JSX.Element {
  const { t } = useI18n();
  const grid = preview.grid ?? null;
  const table = preview.tables.find((item) => item.name === activeSection);

  if (preview.tables.length === 0) {
    return (
      <div className="file-preview-db">
        <div className="file-preview-empty">
          {t("rightPanel.filePreview.noTables")}
        </div>
      </div>
    );
  }

  return (
    <div className="file-preview-db">
      <aside className="file-preview-db-tables">
        {preview.tables.map((item) => (
          <button
            key={item.name}
            type="button"
            className={`file-preview-db-table${
              item.name === activeSection ? " active" : ""
            }`}
            onClick={() => onSelectSection(item.name)}
            disabled={loadingSection != null}
            title={item.name}
          >
            {loadingSection === item.name ? (
              <Loader2 className="spin" size={12} />
            ) : item.kind === "view" ? (
              <View size={12} />
            ) : (
              <Table2 size={12} />
            )}
            <span>{item.name}</span>
          </button>
        ))}
        {preview.truncatedTables ? (
          <div className="file-preview-status-warn file-preview-db-truncated">
            {t("rightPanel.filePreview.truncatedTables", {
              values: { count: preview.tables.length },
            })}
          </div>
        ) : null}
      </aside>
      <section className="file-preview-db-main">
        {table ? (
          <details className="file-preview-db-schema">
            <summary>
              {t("rightPanel.filePreview.columnsSummary", {
                values: { count: table.columns.length },
              })}
            </summary>
            <table className="file-preview-db-columns">
              <thead>
                <tr>
                  <th>{t("rightPanel.filePreview.columnName")}</th>
                  <th>{t("rightPanel.filePreview.columnType")}</th>
                  <th>{t("rightPanel.filePreview.columnNotNull")}</th>
                  <th>{t("rightPanel.filePreview.columnPrimaryKey")}</th>
                </tr>
              </thead>
              <tbody>
                {table.columns.map((column) => (
                  <tr key={column.name}>
                    <td>{column.name}</td>
                    <td className="file-preview-mono">{column.dataType}</td>
                    <td>{column.notNull ? "NOT NULL" : ""}</td>
                    <td>{column.primaryKey ? <KeyRound size={12} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
        {preview.gridError ? (
          <div className="file-preview-inline-error">
            <span>{t("rightPanel.filePreview.sectionFailed")}</span>
            <pre>{preview.gridError}</pre>
          </div>
        ) : grid && grid.rows.length > 0 ? (
          <PreviewDataGrid grid={grid} mode="table" />
        ) : (
          <div className="file-preview-empty">
            {t("rightPanel.filePreview.emptyTable")}
          </div>
        )}
        <div className="file-preview-status">
          <span>
            {grid
              ? t("rightPanel.filePreview.databaseRowLimit", {
                  values: { count: grid.rowLimit },
                })
              : t("rightPanel.fileViewerReadOnlyPreview")}
          </span>
          {grid?.truncatedRows ? (
            <span className="file-preview-status-warn">
              {t("rightPanel.filePreview.truncatedRows", {
                values: { count: grid.rows.length },
              })}
            </span>
          ) : null}
          {grid?.truncatedColumns ? (
            <span className="file-preview-status-warn">
              {t("rightPanel.filePreview.truncatedColumns", {
                values: { count: grid.headers.length },
              })}
            </span>
          ) : null}
          {preview.walPending ? (
            <span className="file-preview-status-warn">
              {t("rightPanel.filePreview.walPending")}
            </span>
          ) : null}
        </div>
      </section>
    </div>
  );
}
