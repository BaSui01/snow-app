import { EyeOff } from "lucide-react";

import type { FilePreviewResult } from "../../../../preload";
import { useI18n } from "../../../i18n";

type SlidesPreviewProps = {
  preview: FilePreviewResult;
};

/** 演示文稿大纲：按放映顺序列出每页标题与文本块。 */
export function SlidesPreview({
  preview,
}: SlidesPreviewProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="file-preview-slides">
      {preview.slides.map((slide) => (
        <article key={slide.index} className="file-preview-slide">
          <header className="file-preview-slide-head">
            <span className="file-preview-slide-index">
              {t("rightPanel.filePreview.slideIndex", {
                values: { index: slide.index },
              })}
            </span>
            {slide.hidden ? (
              <span className="file-preview-slide-hidden">
                <EyeOff size={11} />
                {t("rightPanel.filePreview.slideHidden")}
              </span>
            ) : null}
          </header>
          {slide.title ? (
            <h3 className="file-preview-slide-title">{slide.title}</h3>
          ) : null}
          {slide.blocks.map((block, index) => (
            <p key={index} className="file-preview-slide-block">
              {block}
            </p>
          ))}
          {!slide.title && slide.blocks.length === 0 ? (
            <p className="file-preview-slide-empty">
              {t("rightPanel.filePreview.slideNoText")}
            </p>
          ) : null}
        </article>
      ))}
      {preview.truncatedSlides ? (
        <div className="file-preview-status-warn file-preview-slides-truncated">
          {t("rightPanel.filePreview.truncatedSlides", {
            values: { count: preview.slides.length },
          })}
        </div>
      ) : null}
    </div>
  );
}
