import { memo, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { useI18n } from "../../i18n";

export type DrawingSizeControlProps = {
  sizeRatioOptions: string[];
  sizeTierOptions: string[];
  qualityOptions: Array<{ value: string; labelKey: string }>;
  sizeSummary: string;
  ratio: string;
  setRatio: (ratio: string) => void;
  quality: string;
  setQuality: (quality: string) => void;
  isSizeActive: (value: string) => boolean;
  handleSizeSelect: (value: string) => void;
  sizeTierHint: (value: string) => string;
};

export const DrawingSizeControl = memo(function DrawingSizeControl({
  sizeRatioOptions,
  sizeTierOptions,
  qualityOptions,
  sizeSummary,
  ratio,
  setRatio,
  quality,
  setQuality,
  isSizeActive,
  handleSizeSelect,
  sizeTierHint,
}: DrawingSizeControlProps): React.JSX.Element {
  const { t } = useI18n();
  const [sizePanelOpen, setSizePanelOpen] = useState(false);
  const sizeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // 定位计算：通过 Element.style.top/left 设值，避免 JSX 内联 style={{ ... }}
  useLayoutEffect(() => {
    if (!sizePanelOpen || !sizeTriggerRef.current) return;
    const updatePosition = () => {
      const trigger = sizeTriggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(320, window.innerWidth - 24);
      let top = rect.bottom + margin;
      let left = rect.left;
      if (left + width > window.innerWidth - margin) {
        left = window.innerWidth - width - margin;
      }
      left = Math.max(margin, left);
      const maxHeight = Math.max(120, window.innerHeight - top - margin);
      popover.style.top = `${Math.round(top)}px`;
      popover.style.left = `${Math.round(left)}px`;
      popover.style.width = `${Math.round(width)}px`;
      popover.style.maxHeight = `${Math.round(maxHeight)}px`;
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [sizePanelOpen]);

  if (sizeRatioOptions.length === 0) return <></>;

  return (
    <div className="ai-drawing-size-control">
      <span className="ai-drawing-param-label">
        {t("rightPanel.aiDrawing.tier")}
      </span>
      <div className="ai-drawing-size-trigger-wrap">
        <button
          ref={sizeTriggerRef}
          type="button"
          className={`ai-drawing-size-trigger${sizePanelOpen ? " open" : ""}`}
          title={t("rightPanel.aiDrawing.sizeControlHint")}
          onClick={() => setSizePanelOpen((open) => !open)}
        >
          <span className="ai-drawing-size-summary">{sizeSummary}</span>
          <ChevronDown
            size={12}
            strokeWidth={1.8}
            className={sizePanelOpen ? "rotate-180" : ""}
          />
        </button>
        {sizePanelOpen &&
          createPortal(
            <>
              {/* 点击外部关闭弹层 */}
              <div
                className="ai-drawing-size-backdrop"
                onClick={() => setSizePanelOpen(false)}
              />
              <div ref={popoverRef} className="ai-drawing-size-popover">
                {/* 比例 */}
                <div className="ai-drawing-size-row">
                  <span className="ai-drawing-size-row-title">
                    {t("rightPanel.aiDrawing.ratio")}
                  </span>
                  <div className="ai-drawing-size-grid">
                    <button
                      type="button"
                      className={`ai-drawing-size-option${
                        ratio === "" ? " active" : ""
                      }`}
                      onClick={() => setRatio("")}
                    >
                      {t("rightPanel.aiDrawing.sizeDefault")}
                    </button>
                    {sizeRatioOptions.map((value) => (
                      <button
                        type="button"
                        key={value}
                        className={`ai-drawing-size-option${
                          ratio === value ? " active" : ""
                        }`}
                        onClick={() => setRatio(value)}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 尺寸 */}
                {sizeTierOptions.length > 0 && (
                  <div className="ai-drawing-size-row">
                    <span className="ai-drawing-size-row-title">
                      {t("rightPanel.aiDrawing.resolution")}
                    </span>
                    <div className="ai-drawing-size-grid">
                      <button
                        type="button"
                        className={`ai-drawing-size-option${
                          isSizeActive("") ? " active" : ""
                        }`}
                        onClick={() => handleSizeSelect("")}
                      >
                        {t("rightPanel.aiDrawing.sizeDefault")}
                      </button>
                      {sizeTierOptions.map((value) => {
                        const hint = sizeTierHint(value);
                        return (
                          <button
                            type="button"
                            key={value}
                            className={`ai-drawing-size-option${
                              isSizeActive(value) ? " active" : ""
                            }`}
                            onClick={() => handleSizeSelect(value)}
                          >
                            <span>{value}</span>
                            {hint ? (
                              <em className="ai-drawing-size-hint">{hint}</em>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 质量 */}
                {qualityOptions.length > 0 && (
                  <div className="ai-drawing-size-row">
                    <span className="ai-drawing-size-row-title">
                      {t("toolCall.imagegen.quality", {
                        defaultValue: "Quality",
                      })}
                    </span>
                    <div className="ai-drawing-size-grid">
                      {qualityOptions.map((option) => (
                        <button
                          type="button"
                          key={option.value}
                          className={`ai-drawing-size-option${
                            quality === option.value ? " active" : ""
                          }`}
                          onClick={() => setQuality(option.value)}
                        >
                          <span>
                            {t(option.labelKey) ||
                              (option.value
                                ? option.value.toUpperCase()
                                : t("rightPanel.aiDrawing.qualityDefault"))}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>,
            document.body,
          )}
      </div>
    </div>
  );
});
