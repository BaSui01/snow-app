import type { JSX, ReactNode } from "react";

import { MotionIcon } from "../common/MotionIcon";

const BOOK_PATHS = [
  "M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z",
  "M2 6h4",
  "M2 10h4",
  "M2 14h4",
  "M2 18h4",
];
const TEXT_LINES = [
  { d: "M9.5 8h5", length: 5 },
  { d: "M9.5 12H16", length: 6.5 },
  { d: "M9.5 16H14", length: 4.5 },
];
const TEXT_TOTAL = TEXT_LINES.reduce((sum, line) => sum + line.length, 0);

// 本子不动，正文从左到右逐行写入
const render = (t: number): ReactNode => {
  let consumed = 0;
  const written = t * TEXT_TOTAL;
  return (
    <g>
      {BOOK_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
      {TEXT_LINES.map(({ d, length }) => {
        const local = Math.min(1, Math.max(0, (written - consumed) / length));
        consumed += length;
        if (local <= 0) {
          return null;
        }
        return (
          <path
            key={d}
            d={d}
            pathLength={1}
            strokeDasharray="1 1"
            strokeDashoffset={1 - local}
          />
        );
      })}
    </g>
  );
};

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
