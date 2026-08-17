import { useCallback, useState } from "react";
import type { ReactNode } from "react";

export type TooltipProps = {
  content: ReactNode;
  children: ReactNode;
  /** 浮层方向：top（默认，向上弹出）/ bottom（向下弹出） */
  placement?: "top" | "bottom";
  /** 受控显示：传入时忽略内部 hover 状态（供 DOM 注入内容外部驱动）。 */
  visible?: boolean;
};

export const Tooltip = ({
  content,
  children,
  placement = "top",
  visible,
}: TooltipProps): React.JSX.Element => {
  const [internalVisible, setInternalVisible] = useState(false);
  const isVisible = visible ?? internalVisible;

  const handleMouseEnter = useCallback(() => {
    setInternalVisible(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setInternalVisible(false);
  }, []);

  return (
    <span
      className="tooltip-wrapper"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {isVisible && (
        <span className={`tooltip tooltip-${placement}`} role="tooltip">
          {content}
        </span>
      )}
    </span>
  );
};
