import type { JSX } from "react";

import {
  StrokeDrawIcon,
  type StrokeDrawSegment,
} from "../common/StrokeDrawIcon";

const PROJECT_MEMORY_SEGMENTS: StrokeDrawSegment[] = [
  { d: "M12 18V5", length: 13 },
  { d: "M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4", length: 10.5 },
  { d: "M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5", length: 11 },
  { d: "M17.997 5.125a4 4 0 0 1 2.526 5.77", length: 7 },
  { d: "M18 18a4 4 0 0 0 2-7.464", length: 7 },
  {
    d: "M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517",
    length: 15,
  },
  { d: "M6 18a4 4 0 0 1-2-7.464", length: 7 },
  { d: "M6.003 5.125a4 4 0 0 0-2.526 5.77", length: 7 },
];

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
    <StrokeDrawIcon
      segments={PROJECT_MEMORY_SEGMENTS}
      frameCount={40}
      durationMs={500}
      size={size}
      strokeWidth={strokeWidth}
      hoverScope={hoverScope}
    />
  );
}
