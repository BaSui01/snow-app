import { memo, type ReactNode } from "react";
import {
  ChevronDown,
  Image as ImageIcon,
  Images,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useI18n } from "../../i18n";
import type { DrawingGalleryItem, DrawingLibraryRecord } from "./drawingTypes";

/** 历史区使用的图库记录（与工作台图库列表同构）。 */
export type DrawingHistoryRecord = DrawingLibraryRecord;

export type DrawingHistorySectionProps = {
  historyCollapsed: boolean;
  setHistoryCollapsed: (fn: (prev: boolean) => boolean) => void;
  library: DrawingLibraryRecord[];
  filteredLibrary: DrawingLibraryRecord[];
  visibleLibrary: DrawingLibraryRecord[];
  historyQuery: string;
  setHistoryQuery: (query: string) => void;
  loadLibrary: () => Promise<void>;
  hasMoreLibrary: boolean;
  handleLoadMore: () => void;
  /** 以该图作为参考图重生成：只需路径 / MIME / 提示词。 */
  handleUseAsReference: (
    record: Pick<DrawingLibraryRecord, "relativePath" | "mimeType" | "prompt">,
  ) => void;
  /** 请求删除：调用方仅需要 id 与路径（弹窗据此渲染缩略图）。 */
  handleDelete: (
    record: Pick<DrawingLibraryRecord, "id" | "relativePath">,
  ) => void;
  deleteTarget: Pick<DrawingLibraryRecord, "id" | "relativePath"> | null;
  setDeleteTarget: (
    target: Pick<DrawingLibraryRecord, "id" | "relativePath"> | null,
  ) => void;
  confirmDelete: (
    record: Pick<DrawingLibraryRecord, "id" | "relativePath">,
  ) => Promise<void>;
  openLightbox: (items: DrawingGalleryItem[], index: number) => void;
  proxyForLibraryPath: (relativePath: string) => string;
  formatTime: (iso: string) => string;
  renderLibraryImage: (props: {
    path?: string;
    src?: string;
    alt: string;
    title?: string;
    className?: string;
    loading?: "lazy" | "eager";
    onClick?: () => void;
  }) => ReactNode;
};

export const DrawingHistorySection = memo(function DrawingHistorySection({
  historyCollapsed,
  setHistoryCollapsed,
  library,
  filteredLibrary,
  visibleLibrary,
  historyQuery,
  setHistoryQuery,
  loadLibrary,
  hasMoreLibrary,
  handleLoadMore,
  handleUseAsReference,
  handleDelete,
  deleteTarget,
  setDeleteTarget,
  confirmDelete,
  openLightbox,
  proxyForLibraryPath,
  formatTime,
  renderLibraryImage,
}: DrawingHistorySectionProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <>
      {/* 图库历史（存储） */}
      <div
        className={`ai-drawing-section ai-drawing-history${
          historyCollapsed ? " collapsed" : ""
        }`}
        title={t("rightPanel.aiDrawing.libraryDragHint")}
      >
        <div className="ai-drawing-result-header">
          <span className="ai-drawing-result-title">
            <button
              type="button"
              className="ai-drawing-history-collapse"
              title={
                historyCollapsed
                  ? t("rightPanel.aiDrawing.expand")
                  : t("rightPanel.aiDrawing.collapse")
              }
              aria-expanded={!historyCollapsed}
              onClick={() => setHistoryCollapsed((collapsed) => !collapsed)}
            >
              <ChevronDown size={13} strokeWidth={1.8} />
            </button>
            <Images size={13} strokeWidth={1.8} />
            <span>{t("rightPanel.aiDrawing.history")}</span>
            {library.length > 0 && (
              <span className="ai-drawing-history-count">
                {historyQuery.trim()
                  ? `${filteredLibrary.length} / ${library.length}`
                  : library.length}
              </span>
            )}
          </span>
          <div className="ai-drawing-history-tools">
            {!historyCollapsed && library.length > 0 && (
              <input
                type="text"
                className="ai-drawing-history-search"
                value={historyQuery}
                placeholder={t("rightPanel.aiDrawing.searchHistory")}
                onChange={(event) => setHistoryQuery(event.target.value)}
              />
            )}
            <button
              type="button"
              className="ai-drawing-refresh-btn"
              title={t("rightPanel.aiDrawing.refresh")}
              onClick={() => void loadLibrary()}
            >
              <RefreshCw size={13} strokeWidth={1.8} />
            </button>
          </div>
        </div>

        {historyCollapsed ? null : library.length === 0 ? (
          <div className="ai-drawing-status ai-drawing-status-empty">
            <Images size={18} strokeWidth={1.8} />
            <span>{t("rightPanel.aiDrawing.historyEmpty")}</span>
          </div>
        ) : filteredLibrary.length === 0 ? (
          <div className="ai-drawing-status ai-drawing-status-empty">
            <Images size={18} strokeWidth={1.8} />
            <span>{t("rightPanel.aiDrawing.historyNoMatch")}</span>
          </div>
        ) : (
          <>
            <div className="ai-drawing-library-grid">
              {visibleLibrary.map((record, index) => (
                <div
                  className="ai-drawing-library-item"
                  key={record.id}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      "application/json",
                      JSON.stringify({
                        type: "library-image",
                        path: record.relativePath,
                        mimeType: record.mimeType,
                        name:
                          record.relativePath.split("/").pop() ??
                          record.relativePath,
                      }),
                    );
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                >
                  {renderLibraryImage({
                    path: record.relativePath,
                    alt: record.prompt || record.relativePath,
                    title: `${record.prompt || record.relativePath}\n${formatTime(
                      record.createdAt,
                    )}`,
                    loading: "lazy",
                    onClick: () =>
                      openLightbox(
                        visibleLibrary.map((item) => ({
                          key: item.id,
                          src: proxyForLibraryPath(item.relativePath),
                          record: item,
                        })),
                        index,
                      ),
                  })}
                  <div className="ai-drawing-library-actions">
                    <button
                      type="button"
                      className="ai-drawing-img-action"
                      title={t("toolCall.imagegen.refEditTitle", {
                        defaultValue: "Regenerate using this image",
                      })}
                      onClick={() => handleUseAsReference(record)}
                    >
                      <Sparkles size={13} strokeWidth={1.8} />
                    </button>
                    <button
                      type="button"
                      className="ai-drawing-img-action"
                      title={t("toolCall.imagegen.zoom", {
                        defaultValue: "Zoom image",
                      })}
                      onClick={() =>
                        openLightbox(
                          visibleLibrary.map((item) => ({
                            key: item.id,
                            src: proxyForLibraryPath(item.relativePath),
                            record: item,
                          })),
                          index,
                        )
                      }
                    >
                      <ImageIcon size={13} strokeWidth={1.8} />
                    </button>
                    <button
                      type="button"
                      className="ai-drawing-img-action ai-drawing-delete-btn"
                      title={t("rightPanel.aiDrawing.delete")}
                      onClick={() => handleDelete(record)}
                    >
                      <Trash2 size={13} strokeWidth={1.8} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {hasMoreLibrary && (
              <button
                type="button"
                className="ai-drawing-load-more"
                onClick={handleLoadMore}
              >
                {t("rightPanel.aiDrawing.loadMore")}
              </button>
            )}
          </>
        )}
      </div>

      {/* 删除确认弹窗 */}
      {deleteTarget && (
        <div
          className="ai-drawing-delete-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t("rightPanel.aiDrawing.deleteDialogTitle")}
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="ai-drawing-delete-dialog-body"
            onClick={(event) => event.stopPropagation()}
          >
            {renderLibraryImage({
              path: deleteTarget.relativePath,
              alt: t("rightPanel.aiDrawing.deleteDialogTitle"),
              className: "ai-drawing-delete-thumb",
            })}
            <p className="ai-drawing-delete-text">
              {t("rightPanel.aiDrawing.deleteDialogBody")}
            </p>
            <div className="ai-drawing-delete-actions">
              <button
                type="button"
                className="ai-drawing-delete-cancel"
                onClick={() => setDeleteTarget(null)}
              >
                {t("rightPanel.aiDrawing.deleteDialogCancel")}
              </button>
              <button
                type="button"
                className="ai-drawing-delete-ok"
                onClick={() => void confirmDelete(deleteTarget)}
              >
                {t("rightPanel.aiDrawing.deleteDialogConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});
