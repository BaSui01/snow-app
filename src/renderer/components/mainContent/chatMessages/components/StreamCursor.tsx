import { memo } from "react";
import { useStreamCursor } from "../../../../hooks/useStreamCursor";
import { findStreamCursorLucideIcon } from "../../../sidebar/themeSettings/streamCursorIcons";

/**
 * Pulsing indicator that marks the AI response as actively streaming.
 *
 * 根据主题配置渲染三种形态：
 * - dot（默认）：脉冲圆点
 * - lucide：内置 lucide 图标，带旋转动画
 * - custom：用户上传的自定义 SVG 图标
 */
const StreamCursorInner = (): React.JSX.Element => {
  const cursor = useStreamCursor();

  if (cursor.iconType === "lucide") {
    const Icon = findStreamCursorLucideIcon(cursor.lucideName);
    if (Icon) {
      return (
        <span className="stream-cursor" aria-hidden="true">
          <Icon
            size={cursor.iconSize}
            strokeWidth={2}
            className="stream-cursor-lucide-icon"
          />
        </span>
      );
    }
  }

  if (cursor.iconType === "custom") {
    return (
      <span className="stream-cursor stream-cursor-custom" aria-hidden="true">
        <span className="stream-cursor-custom-icon" />
      </span>
    );
  }

  return (
    <span className="stream-cursor" aria-hidden="true">
      <span className="stream-cursor-dot" />
    </span>
  );
};

export const StreamCursor = memo(StreamCursorInner);

StreamCursor.displayName = "StreamCursor";
