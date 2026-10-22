import type { JSX, ReactNode } from "react";

import { dampedWave, fmt, MotionIcon } from "../common/MotionIcon";

// 以手柄末端为圆心轻摆
const render = (t: number): ReactNode => (
  <g transform={`rotate(${fmt(dampedWave(t, 10, 1.5))} 21 21)`}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.34-4.34" />
  </g>
);

export type AnimatedSearchIconProps = {
  size?: number;
  strokeWidth?: number;
  hoverScope?: string;
};

export function AnimatedSearchIcon({
  size = 16,
  strokeWidth = 1.8,
  hoverScope = ".sidebar-search-btn",
}: AnimatedSearchIconProps): JSX.Element {
  return (
    <MotionIcon
      render={render}
      frameCount={34}
      durationMs={560}
      size={size}
      strokeWidth={strokeWidth}
      hoverScope={hoverScope}
    />
  );
}
