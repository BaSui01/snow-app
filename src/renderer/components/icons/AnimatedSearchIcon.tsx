import type { JSX } from "react";

import {
  StrokeDrawIcon,
  type StrokeDrawSegment,
} from "../common/StrokeDrawIcon";

const SEARCH_SEGMENTS: StrokeDrawSegment[] = [
  {
    d: "M16.66 16.66A8 8 0 1 1 5.34 5.34A8 8 0 1 1 16.66 16.66L21 21",
    length: 51,
  },
];

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
    <StrokeDrawIcon
      segments={SEARCH_SEGMENTS}
      frameCount={32}
      durationMs={500}
      size={size}
      strokeWidth={strokeWidth}
      hoverScope={hoverScope}
    />
  );
}
