import { memo } from "react";
import { Columns2, ExternalLink, Rows3, WrapText } from "lucide-react";

import { GitDiffView } from "../../../../common/GitDiffView";
import {
  setDiffViewMode,
  setDiffWrapLines,
  useDiffViewMode,
  useDiffWrapLines,
} from "../../../../common/diffViewPreferences";
import { useI18n } from "../../../../../i18n";

type MiniDiffViewerProps = {
  fileName: string;
  oldContent: string;
  newContent: string;
  /**
   * 旧内容在真实源文件中的起始行号(1-based)。
   * 用于编辑工具调用时,让 diff 显示正确的源文件行号而非始终从 1 开始。
   */
  startLine?: number;
  /** 在右侧面板新标签页中查看完整 diff 的回调;未提供时不渲染按钮。 */
  onOpenInTab?: () => void;
  /** 打开按钮的 title / aria-label 文案。 */
  openInTabLabel?: string;
};

/**
 * 工具调用消息中的紧凑差异视图。
 * 基于 @git-diff-view/react 渲染,支持语法高亮、单/双列与换行切换。
 */
export const MiniDiffViewer = memo(
  ({
    fileName,
    oldContent,
    newContent,
    startLine,
    onOpenInTab,
    openInTabLabel,
  }: MiniDiffViewerProps): React.JSX.Element => {
    const { t } = useI18n();
    const viewMode = useDiffViewMode();
    const wrapLines = useDiffWrapLines();

    return (
      <div className="tool-call-diff-shell">
        <div className="tool-call-diff-content">
          <div className="tool-call-diff-view">
            <GitDiffView
              fileName={fileName}
              oldContent={oldContent}
              newContent={newContent}
              fontSize={11}
              oldStartLine={startLine}
              newStartLine={startLine}
              viewMode={viewMode}
              wrapLines={wrapLines}
            />
          </div>
        </div>
        <div className="tool-call-diff-actions">
          <button
            type="button"
            className={`tool-call-diff-action-btn${
              viewMode === "unified" ? " active" : ""
            }`}
            title={t("diffViewer.unifiedMode")}
            aria-label={t("diffViewer.unifiedMode")}
            onClick={() => setDiffViewMode("unified")}
          >
            <Rows3 size={12} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className={`tool-call-diff-action-btn${
              viewMode === "split" ? " active" : ""
            }`}
            title={t("diffViewer.splitMode")}
            aria-label={t("diffViewer.splitMode")}
            onClick={() => setDiffViewMode("split")}
          >
            <Columns2 size={12} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className={`tool-call-diff-action-btn${wrapLines ? " active" : ""}`}
            title={t("diffViewer.wrapLines")}
            aria-label={t("diffViewer.wrapLines")}
            aria-pressed={wrapLines}
            onClick={() => setDiffWrapLines(!wrapLines)}
          >
            <WrapText size={12} strokeWidth={1.8} />
          </button>
          {onOpenInTab ? (
            <button
              type="button"
              className="tool-call-diff-action-btn"
              title={openInTabLabel}
              aria-label={openInTabLabel}
              onClick={onOpenInTab}
            >
              <ExternalLink size={12} strokeWidth={1.8} />
            </button>
          ) : null}
        </div>
      </div>
    );
  },
);

MiniDiffViewer.displayName = "MiniDiffViewer";
