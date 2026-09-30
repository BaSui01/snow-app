import { useMemo } from "react";
import type { JSX, ReactNode } from "react";

import { IconFramePlayer } from "./IconFramePlayer";

export type StrokeDrawSegment = {
  d: string;
  length: number;
};

export const buildStrokeDrawFrames = (
  segments: StrokeDrawSegment[],
  frameCount: number,
): ReactNode[] => {
  const lengths = segments.map((segment) =>
    segment.length > 0 ? segment.length : 1,
  );
  const total = lengths.reduce((sum, length) => sum + length, 0);

  return Array.from({ length: frameCount }, (_, frameIndex) => {
    const drawn = ((frameIndex + 1) / frameCount) * total;
    let consumed = 0;
    const parts: ReactNode[] = [];

    segments.forEach((segment, segmentIndex) => {
      const start = consumed;
      consumed += lengths[segmentIndex];
      const local = Math.min(
        1,
        Math.max(0, (drawn - start) / lengths[segmentIndex]),
      );
      if (local <= 0) {
        return;
      }
      parts.push(
        <path
          key={segmentIndex}
          d={segment.d}
          pathLength={1}
          strokeDasharray="1 1"
          strokeDashoffset={1 - local}
        />,
      );
    });

    return <g>{parts}</g>;
  });
};

export const buildCompleteFrame = (
  segments: StrokeDrawSegment[],
): ReactNode => (
  <g>
    {segments.map((segment, segmentIndex) => (
      <path key={segmentIndex} d={segment.d} />
    ))}
  </g>
);

export type StrokeDrawIconProps = {
  segments: StrokeDrawSegment[];
  frameCount?: number;
  durationMs?: number;
  size?: number;
  strokeWidth?: number;
  hoverScope?: string;
};

export function StrokeDrawIcon({
  segments,
  frameCount = 32,
  durationMs = 500,
  size = 16,
  strokeWidth = 1.8,
  hoverScope,
}: StrokeDrawIconProps): JSX.Element {
  const frames = useMemo(
    () => buildStrokeDrawFrames(segments, frameCount),
    [segments, frameCount],
  );

  return (
    <IconFramePlayer
      frames={frames}
      size={size}
      strokeWidth={strokeWidth}
      fps={(frameCount * 1000) / durationMs}
      loop={false}
      hoverPlay
      hoverScope={hoverScope}
      restFrame="last"
    />
  );
}
