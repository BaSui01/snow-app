import type { JSX } from "react";

import {
  StrokeDrawIcon,
  type StrokeDrawSegment,
} from "../common/StrokeDrawIcon";

const MEMO_SEGMENTS: StrokeDrawSegment[] = [
  {
    d: "M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z",
    length: 68.6,
  },
  { d: "M2 6h4", length: 4 },
  { d: "M2 10h4", length: 4 },
  { d: "M2 14h4", length: 4 },
  { d: "M2 18h4", length: 4 },
  { d: "M9.5 8h5", length: 5 },
  { d: "M9.5 12H16", length: 6.5 },
  { d: "M9.5 16H14", length: 4.5 },
];

export type AnimatedMemoIconProps = {
  size?: number;
  strokeWidth?: number;
  hoverScope?: string;
};

export function AnimatedMemoIcon({
  size = 16,
  strokeWidth = 1.8,
  hoverScope = ".sidebar-memo-btn",
}: AnimatedMemoIconProps): JSX.Element {
  return (
    <StrokeDrawIcon
      segments={MEMO_SEGMENTS}
      frameCount={40}
      durationMs={520}
      size={size}
      strokeWidth={strokeWidth}
      hoverScope={hoverScope}
    />
  );
}
