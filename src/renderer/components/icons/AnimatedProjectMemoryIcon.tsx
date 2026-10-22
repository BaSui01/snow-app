import type { JSX, ReactNode } from "react";

import { dampedWave, fmt, MotionIcon } from "../common/MotionIcon";

const BRAIN_PATHS = [
  "M12 18V5",
  "M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4",
  "M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5",
  "M17.997 5.125a4 4 0 0 1 2.526 5.77",
  "M18 18a4 4 0 0 0 2-7.464",
  "M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517",
  "M6 18a4 4 0 0 1-2-7.464",
  "M6.003 5.125a4 4 0 0 0-2.526 5.77",
];

// 轻微脉动，像在思考
const render = (t: number): ReactNode => {
  const scale = 1 + Math.abs(dampedWave(t, 0.09, 1));
  return (
    <g transform={`translate(12 12) scale(${fmt(scale)}) translate(-12 -12)`}>
      {BRAIN_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </g>
  );
};

export type AnimatedProjectMemoryIconProps = {
  size?: number;
  strokeWidth?: number;
  hoverScope?: string;
};

export function AnimatedProjectMemoryIcon({
  size = 16,
  strokeWidth = 1.8,
  hoverScope = ".sidebar-memory-btn",
}: AnimatedProjectMemoryIconProps): JSX.Element {
  return (
    <MotionIcon
      render={render}
      frameCount={36}
      durationMs={620}
      size={size}
      strokeWidth={strokeWidth}
      hoverScope={hoverScope}
    />
  );
}
