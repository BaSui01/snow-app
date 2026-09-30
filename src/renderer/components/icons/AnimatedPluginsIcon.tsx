import { useMemo } from "react";
import type { JSX, ReactNode } from "react";

import { IconFramePlayer } from "../common/IconFramePlayer";
import {
  buildCompleteFrame,
  buildStrokeDrawFrames,
  type StrokeDrawSegment,
} from "../common/StrokeDrawIcon";

const PLUGINS_SEGMENTS: StrokeDrawSegment[] = [
  {
    d: "M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z",
    length: 100,
  },
];

const DRAW_FRAMES = 37;
const BOUNCE_SCALES = [1.07, 1.03, 1];
const TOTAL_FRAMES = DRAW_FRAMES + BOUNCE_SCALES.length;
const DURATION_MS = 520;

const buildFrames = (): ReactNode[] => {
  const drawFrames = buildStrokeDrawFrames(PLUGINS_SEGMENTS, DRAW_FRAMES);
  const completeFrame = buildCompleteFrame(PLUGINS_SEGMENTS);
  const bounceFrames = BOUNCE_SCALES.map((scale) => (
    <g transform={`translate(12 12) scale(${scale}) translate(-12 -12)`}>
      {completeFrame}
    </g>
  ));
  return [...drawFrames, ...bounceFrames];
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
