import { useMemo } from "react";
import type { JSX, ReactNode } from "react";

import { IconFramePlayer } from "./IconFramePlayer";

// t 取值 0..1，t=1 为静止形态
export type MotionRender = (t: number) => ReactNode;

export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// 衰减摆动：起止均为 0
export const dampedWave = (
  t: number,
  amplitude: number,
  cycles: number,
): number =>
  amplitude * Math.sin(2 * Math.PI * cycles * t) * Math.pow(1 - t, 1.4);

export const fmt = (value: number): string => value.toFixed(3);

export type MotionIconProps = {
  render: MotionRender;
  frameCount?: number;
  durationMs?: number;
  size?: number;
  strokeWidth?: number;
  hoverScope?: string;
};

export function MotionIcon({
  render,
  frameCount = 30,
  durationMs = 500,
  size = 16,
  strokeWidth = 1.8,
  hoverScope,
}: MotionIconProps): JSX.Element {
  const frames = useMemo(
    () =>
      Array.from({ length: frameCount }, (_, i) =>
        render(frameCount > 1 ? i / (frameCount - 1) : 1),
      ),
    [render, frameCount],
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
