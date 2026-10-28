import { Loader2 } from "lucide-react";
import { lazy, Suspense } from "react";

import type { FilePreviewResult } from "../../../../preload";
import { DatabasePreview } from "./DatabasePreview";
import type { PreviewUnavailableInfo } from "./PreviewUnavailable";
import { SlidesPreview } from "./SlidesPreview";
import { SpreadsheetPreview } from "./SpreadsheetPreview";

// docx-preview 体积较大，按需加载为独立 chunk。
const DocxPreview = lazy(() => import("./DocxPreview"));

type FilePreviewViewProps = {
  preview: FilePreviewResult;
  activeSection: string;
  loadingSection: string | null;
  onSelectSection: (name: string) => void;
  /** 渲染层解析失败（DOCX）：交由宿主切换到不可预览面板。 */
  onFailure: (info: Omit<PreviewUnavailableInfo, "size">) => void;
};

const loadingFallback = (
  <div className="file-preview-loading">
    <Loader2 className="spin" size={18} />
  </div>
);

/** 按预览类型分派到对应的只读预览组件。 */
export function FilePreviewView({
  preview,
  activeSection,
  loadingSection,
  onSelectSection,
  onFailure,
}: FilePreviewViewProps): React.JSX.Element | null {
  switch (preview.kind) {
    case "spreadsheet":
      return (
        <SpreadsheetPreview
          preview={preview}
          activeSection={activeSection}
          loadingSection={loadingSection}
          onSelectSection={onSelectSection}
        />
      );
    case "database":
      return (
        <DatabasePreview
          preview={preview}
          activeSection={activeSection}
          loadingSection={loadingSection}
          onSelectSection={onSelectSection}
        />
      );
    case "slides":
      return <SlidesPreview preview={preview} />;
    case "docx":
      return preview.data ? (
        <Suspense fallback={loadingFallback}>
          <DocxPreview data={preview.data} onFailure={onFailure} />
        </Suspense>
      ) : null;
    default:
      return null;
  }
}
