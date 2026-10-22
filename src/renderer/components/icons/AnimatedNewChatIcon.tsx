import type { JSX, ReactNode } from "react";

import { dampedWave, fmt, MotionIcon } from "../common/MotionIcon";

const BOX_D = "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7";
const PEN_D =
  "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z";

// 笔绕笔尖小幅摆动，像在写字
const render = (t: number): ReactNode => {
  const angle = dampedWave(t, 12, 2);
  const shift = dampedWave(t, 0.8, 1);
  return (
    <g>
      <path d={BOX_D} />
      <g
        transform={`translate(${fmt(shift)} 0) rotate(${fmt(angle)} 8.6 15.4)`}
      >
        <path d={PEN_D} />
      </g>
    </g>
  );
};

export type AnimatedNewChatIconProps = {
  size?: number;
  strokeWidth?: number;
  hoverScope?: string;
};

export function AnimatedNewChatIcon({
  size = 16,
  strokeWidth = 1.8,
  hoverScope = ".sidebar-new-chat-btn",
}: AnimatedNewChatIconProps): JSX.Element {
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
