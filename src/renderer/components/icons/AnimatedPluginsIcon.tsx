import type { JSX, ReactNode } from "react";

import { dampedWave, fmt, MotionIcon } from "../common/MotionIcon";

const PUZZLE_D =
  "M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z";

// 拼图块轻轻扭一下
const render = (t: number): ReactNode => {
  const angle = dampedWave(t, 12, 1.5);
  const scale = 1 + 0.05 * Math.sin(Math.PI * t);
  return (
    <g
      transform={`rotate(${fmt(angle)} 12 12) translate(12 12) scale(${fmt(scale)}) translate(-12 -12)`}
    >
      <path d={PUZZLE_D} />
    </g>
  );
};

export type AnimatedPluginsIconProps = {
  size?: number;
  strokeWidth?: number;
  hoverScope?: string;
};

export function AnimatedPluginsIcon({
  size = 16,
  strokeWidth = 1.8,
  hoverScope = ".sidebar-plugins-btn",
}: AnimatedPluginsIconProps): JSX.Element {
  return (
    <MotionIcon
      render={render}
      frameCount={36}
      durationMs={600}
      size={size}
      strokeWidth={strokeWidth}
      hoverScope={hoverScope}
    />
  );
}
