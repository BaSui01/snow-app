import { memo } from "react";
import { useStreamCursor } from "../../../../hooks/useStreamCursor";
import { AnimatedSnowBotIcon } from "../../../icons/AnimatedSnowBotIcon";
import { findStreamCursorLucideIcon } from "../../../sidebar/themeSettings/streamCursorIcons";
import { themeBgUrl } from "../../../../utils/themeBgUrl";
import { StreamCursorCanvas } from "../../../sidebar/themeSettings/StreamCursorCanvas";

/**
 * Pulsing indicator that marks the AI response as actively streaming.
 *
 * 根据主题配置渲染六种形态：
 * - dot（默认）：脉冲圆点
 * - lucide：内置 lucide 图标，带旋转动画
 * - custom：用户上传的自定义 SVG 图标
 * - snowbot：内置 Snow Bot 动态机器人图标
 * - image：用户上传的任意图片（含 GIF），无额外动画
 * - canvas：用户上传的 JS 绘制脚本（Worker 中运行）
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

  if (cursor.iconType === "snowbot") {
    return (
      <span className="stream-cursor" aria-hidden="true">
        <AnimatedSnowBotIcon size={cursor.iconSize} strokeWidth={2} />
      </span>
    );
  }

  if (cursor.iconType === "custom") {
    return (
      <span className="stream-cursor stream-cursor-custom" aria-hidden="true">
        <span className="stream-cursor-custom-icon" />
      </span>
    );
  }

  if (cursor.iconType === "image" && cursor.svgPath) {
    // 原样显示（GIF 自带动画），高度跟随尺寸，宽度按比例。
    return (
      <span className="stream-cursor" aria-hidden="true">
        <img
          src={themeBgUrl(cursor.svgPath)}
          alt=""
          draggable={false}
          className="stream-cursor-image-icon"
          style={{ height: `${cursor.iconSize}px` }}
        />
      </span>
    );
  }

  if (cursor.iconType === "canvas" && cursor.svgPath) {
    return (
      <span className="stream-cursor" aria-hidden="true">
        <StreamCursorCanvas
          scriptPath={cursor.svgPath}
          size={cursor.iconSize}
        />
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
