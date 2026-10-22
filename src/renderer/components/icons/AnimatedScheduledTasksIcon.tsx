import type { JSX, ReactNode } from "react";

import { easeInOut, fmt, MotionIcon } from "../common/MotionIcon";

const BASE_PATHS = [
  "M21 7.338V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h2.338",
  "M8 2v3",
  "M16 2v3",
  "M3 9h5.859",
  "M16 10a6 6 0 1 1 0 12a6 6 0 1 1 0-12",
];
const HANDS_D = "M16 14v2.2l1.6 1";

// 只有指针转一圈
const render = (t: number): ReactNode => (
  <g>
    {BASE_PATHS.map((d) => (
      <path key={d} d={d} />
    ))}
    <path d={HANDS_D} transform={`rotate(${fmt(360 * easeInOut(t))} 16 16)`} />
  </g>
);

export type AnimatedScheduledTasksIconProps = {
  size?: number;
  strokeWidth?: number;
  hoverScope?: string;
};

export function AnimatedScheduledTasksIcon({
  size = 16,
  strokeWidth = 1.8,
  hoverScope = ".sidebar-scheduled-tasks-btn",
}: AnimatedScheduledTasksIconProps): JSX.Element {
  return (
    <MotionIcon
      render={render}
      frameCount={40}
      durationMs={680}
      size={size}
      strokeWidth={strokeWidth}
      hoverScope={hoverScope}
    />
  );
}
