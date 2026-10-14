import { memo, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Download, Sparkles, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { DrawingGalleryItem, DrawingLibraryRecord } from "./drawingTypes";

/** 灯箱项：画廊项的超集（`record` 已由共享类型保证形状一致）。 */
export type LightboxGalleryItem = DrawingGalleryItem;

/**
 * 可保存项的**最小结构契约**：单张保存只读取 `src`、`image.path` 与
 * `record.relativePath`，因此用结构化最小类型而非完整画廊项，让画廊项与
 * 灯箱项都能直接传入。
 */
export type SavableImageItem = {
  src: string;
  key?: string;
  path?: string;
  image?: { path?: string };
  record?: { relativePath?: string; mimeType?: string; prompt?: string };
};

export type DrawingLightboxProps = {
  lightbox: {
    items: any[];
    index: number;
  } | null;
  closeLightbox: () => void;
  lightboxStep: (step: number) => void;
  saving: boolean;
  handleSaveOne: (item: any) => Promise<void>;
  handleUseAsReference: (record: any) => void;
  formatTime: (iso: string) => string;
  renderLibraryImage: (props: {
    path?: string;
    src?: string;
    alt: string;
  }) => ReactNode;
};

export const DrawingLightbox = memo(function DrawingLightbox({
  lightbox,
  closeLightbox,
  lightboxStep,
  saving,
  handleSaveOne,
  handleUseAsReference,
  formatTime,
  renderLibraryImage,
}: DrawingLightboxProps): React.JSX.Element | null {
  const { t } = useI18n();

  if (!lightbox) return null;
  const lightboxItem = lightbox.items[lightbox.index];
  if (!lightboxItem) return null;

  return (
    <div
      className="ai-drawing-lightbox"
      role="dialog"
      aria-modal="true"
      onClick={closeLightbox}
    >
      <button
        type="button"
        className="ai-drawing-lightbox-close"
        title={t("toolCall.imagegen.close", { defaultValue: "Close" })}
        onClick={closeLightbox}
      >
        <X size={18} strokeWidth={1.8} />
      </button>
      {lightbox.items.length > 1 && (
        <>
          <button
            type="button"
            className="ai-drawing-lightbox-nav ai-drawing-lightbox-prev"
            title={t("toolCall.imagegen.prev", { defaultValue: "Previous" })}
            onClick={(event) => {
              event.stopPropagation();
              lightboxStep(-1);
            }}
          >
            <ChevronLeft size={22} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="ai-drawing-lightbox-nav ai-drawing-lightbox-next"
            title={t("toolCall.imagegen.next", { defaultValue: "Next" })}
            onClick={(event) => {
              event.stopPropagation();
              lightboxStep(1);
            }}
          >
            <ChevronRight size={22} strokeWidth={1.8} />
          </button>
        </>
      )}
      <div
        className="ai-drawing-lightbox-body"
        onClick={(event) => event.stopPropagation()}
      >
        {lightbox.items.length > 1 && (
          <span className="ai-drawing-lightbox-counter">
            {t("rightPanel.aiDrawing.lightboxCounter", {
              values: {
                index: lightbox.index + 1,
                total: lightbox.items.length,
              },
            })}
          </span>
        )}
        {renderLibraryImage({
          path:
            lightboxItem.path ??
            lightboxItem.record?.relativePath ??
            lightboxItem.image?.path,
          src:
            (lightboxItem.path ??
            lightboxItem.record?.relativePath ??
            lightboxItem.image?.path)
              ? undefined
              : lightboxItem.src,
          alt: t("toolCall.imagegen.generatedImage", {
            defaultValue: "Generated image",
          }),
        })}
        {lightboxItem.record?.prompt && (
          <div className="ai-drawing-lightbox-meta">
            <span className="ai-drawing-lightbox-prompt">
              {lightboxItem.record.prompt}
            </span>
            <span className="ai-drawing-lightbox-time">
              {formatTime(lightboxItem.record.createdAt)}
            </span>
          </div>
        )}
        <div className="ai-drawing-lightbox-actions">
          {lightboxItem.record && (
            <button
              type="button"
              className="ai-drawing-lightbox-btn"
              onClick={() => {
                if (lightboxItem.record) {
                  handleUseAsReference(lightboxItem.record);
                }
                closeLightbox();
              }}
            >
              <Sparkles size={14} strokeWidth={1.8} />
              <span>
                {t("toolCall.imagegen.refEdit", {
                  defaultValue: "Use as reference",
                })}
              </span>
            </button>
          )}
          <button
            type="button"
            className="ai-drawing-lightbox-btn"
            disabled={saving}
            onClick={() => void handleSaveOne(lightboxItem)}
          >
            <Download size={14} strokeWidth={1.8} />
            <span>
              {t("toolCall.imagegen.download", {
                defaultValue: "Save image",
              })}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
});
