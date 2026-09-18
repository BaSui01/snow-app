import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/** 气泡锚点：触发按钮（或右键菜单点击处）在 viewport 中的位置。 */
export type GitConfirmAnchor = {
  left: number;
  right: number;
  bottom: number;
};

type GitConfirmBubbleProps = {
  anchor: GitConfirmAnchor;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

const BUBBLE_WIDTH = 168;
const ARROW_SIZE = 8;
const EDGE_GAP = 6;

/**
 * Git 操作二次确认气泡：portal 渲染在触发按钮下方，箭头指向触发位置；
 * 点击气泡外部或按 Esc 取消。外观与右侧面板关闭标签页的确认气泡一致。
 */
export function GitConfirmBubble({
  anchor,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: GitConfirmBubbleProps): React.JSX.Element {
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && bubbleRef.current?.contains(target)) {
        return;
      }
      onCancel();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onCancel();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onCancel]);

  const left = Math.max(
    EDGE_GAP,
    Math.min(anchor.right - BUBBLE_WIDTH, window.innerWidth - BUBBLE_WIDTH - EDGE_GAP),
  );
  const center = anchor.left + (anchor.right - anchor.left) / 2;
  const arrowLeft = Math.max(
    10,
    Math.min(center - left - ARROW_SIZE / 2, BUBBLE_WIDTH - 18),
  );

  return createPortal(
    <div
      ref={bubbleRef}
      className="git-confirm-bubble"
      style={{ left, top: anchor.bottom + EDGE_GAP }}
      role="tooltip"
    >
      <span
        className="git-confirm-bubble-arrow"
        style={{ left: arrowLeft }}
        aria-hidden="true"
      />
      <span className="git-confirm-bubble-text">{message}</span>
      <div className="git-confirm-bubble-actions">
        <button
          type="button"
          className="git-confirm-bubble-btn primary"
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          className="git-confirm-bubble-btn"
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
      </div>
    </div>,
    document.body,
  );
}