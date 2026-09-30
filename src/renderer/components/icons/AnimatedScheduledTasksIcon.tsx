import { useMemo } from "react";
import type { JSX, ReactNode } from "react";

import { IconFramePlayer } from "../common/IconFramePlayer";
import {
  buildCompleteFrame,
  buildStrokeDrawFrames,
  type StrokeDrawSegment,
} from "../common/StrokeDrawIcon";

const SCHEDULED_BASE_SEGMENTS: StrokeDrawSegment[] = [
  {
    d: "M21 7.338V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h2.338",
    length: 56,
  },
  { d: "M8 2v3", length: 3 },
  { d: "M16 2v3", length: 3 },
  { d: "M3 9h5.859", length: 6 },
  { d: "M16 10a6 6 0 1 1 0 12a6 6 0 1 1 0-12", length: 38 },
];

const SCHEDULED_HANDS_SEGMENT: StrokeDrawSegment = {
  d: "M16 14v2.2l1.6 1",
  length: 5,
};

const DRAW_FRAMES = 24;
const SPIN_FRAMES = 17;
const TOTAL_FRAMES = DRAW_FRAMES + SPIN_FRAMES;
const SPIN_STEP_DEG = 360 / (SPIN_FRAMES - 1);
const DURATION_MS = 620;

const buildFrames = (): ReactNode[] => {
  const drawFrames = buildStrokeDrawFrames(
    [...SCHEDULED_BASE_SEGMENTS, SCHEDULED_HANDS_SEGMENT],
    DRAW_FRAMES,
  );
  const baseFrame = buildCompleteFrame(SCHEDULED_BASE_SEGMENTS);
  const spinFrames = Array.from({ length: SPIN_FRAMES }, (_, spinIndex) => (
    <g>
      {baseFrame}
      <path
        d={SCHEDULED_HANDS_SEGMENT.d}
        transform={`rotate(${spinIndex * SPIN_STEP_DEG} 16 16)`}
      />
    </g>
  ));
  return [...drawFrames, ...spinFrames];
};

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
  const frames = useMemo(buildFrames, []);

  return (
    <IconFramePlayer
      frames={frames}
      size={size}
      strokeWidth={strokeWidth}
      fps={(TOTAL_FRAMES * 1000) / DURATION_MS}
      loop={false}
      hoverPlay
      hoverScope={hoverScope}
      restFrame="last"
    />
  );
}
