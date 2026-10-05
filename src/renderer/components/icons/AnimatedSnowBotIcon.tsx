import type { JSX, ReactNode } from "react";

import { IconFramePlayer } from "../common/IconFramePlayer";

const HEAD = (
  <>
    <rect x="3.6" y="5.6" width="16.8" height="13.8" rx="4.6" />
    <path d="M12 5.6V3.3" />
    <circle cx="12" cy="2.4" r="0.8" />
    <path d="M10.9 15.3q1.1 0.9 2.2 0" />
  </>
);

const EYES_OPEN = (
  <>
    <circle cx="9" cy="11.9" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="15" cy="11.9" r="1.5" fill="currentColor" stroke="none" />
  </>
);

const EYES_BLINK = (
  <>
    <path d="M7.9 12q1.1 0.7 2.2 0" />
    <path d="M13.9 12q1.1 0.7 2.2 0" />
  </>
);

const EYES_LOOK_UP_LEFT = (
  <>
    <circle cx="7.6" cy="10.5" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="13.6" cy="10.5" r="1.5" fill="currentColor" stroke="none" />
  </>
);

const EYES_LOOK_UP_RIGHT = (
  <>
    <circle cx="10.4" cy="10.5" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="16.4" cy="10.5" r="1.5" fill="currentColor" stroke="none" />
  </>
);

const EYES_SLEEP = (
  <>
    <path d="M7.9 11.8q1.1 1.25 2.2 0" />
    <path d="M13.9 11.8q1.1 1.25 2.2 0" />
  </>
);

const Z1 = (
  <path d="M0 0h2.4l-2.4 2.4h2.4" transform="translate(14.6 2.4) scale(0.6)" />
);
const Z2 = (
  <path d="M0 0h2.4l-2.4 2.4h2.4" transform="translate(16.9 1.4) scale(0.7)" />
);
const Z3 = (
  <path d="M0 0h2.4l-2.4 2.4h2.4" transform="translate(19.3 0.9) scale(0.8)" />
);

const Z1Z2 = (
  <>
    {Z1}
    {Z2}
  </>
);

const Z1Z2Z3 = (
  <>
    {Z1}
    {Z2}
    {Z3}
  </>
);

const frame = (eyes: ReactNode, zzz?: ReactNode): ReactNode => (
  <g>
    {HEAD}
    {eyes}
    {zzz}
  </g>
);

const FRAMES: ReactNode[] = [
  frame(EYES_OPEN),
  frame(EYES_BLINK),
  frame(EYES_OPEN),
  frame(EYES_LOOK_UP_LEFT),
  frame(EYES_LOOK_UP_RIGHT),
  frame(EYES_OPEN),
  frame(EYES_BLINK),
  frame(EYES_OPEN),
  frame(EYES_SLEEP),
  frame(EYES_SLEEP, Z1),
  frame(EYES_SLEEP, Z1Z2),
  frame(EYES_SLEEP, Z1Z2Z3),
];

const FRAME_DURATIONS_MS = [
  1600, 120, 320, 600, 600, 320, 120, 260, 320, 320, 320, 1200,
];

export type AnimatedSnowBotIconProps = {
  size?: number;
  strokeWidth?: number;
};

export function AnimatedSnowBotIcon({
  size = 16,
  strokeWidth = 1.8,
}: AnimatedSnowBotIconProps): JSX.Element {
  return (
    <IconFramePlayer
      frames={FRAMES}
      size={size}
      strokeWidth={strokeWidth}
      durations={FRAME_DURATIONS_MS}
    />
  );
}
