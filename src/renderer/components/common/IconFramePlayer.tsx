import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

export type IconFramePlayerProps = {
  frames: ReactNode[];
  size?: number;
  viewBox?: string;
  strokeWidth?: number;
  fps?: number;
  durations?: number[];
  loop?: boolean;
  playing?: boolean;
  hoverPlay?: boolean;
  hoverScope?: string;
  restFrame?: "first" | "last";
  className?: string;
};

const useFrameIndex = (
  frameCount: number,
  fps: number,
  durations: number[] | undefined,
  active: boolean,
  loop: boolean,
  restIndex: number,
): number => {
  const [index, setIndex] = useState(restIndex);
  const indexRef = useRef(restIndex);
  const durationKey =
    durations && durations.length === frameCount ? durations.join(":") : "";

  useEffect(() => {
    if (!active || frameCount <= 1) {
      indexRef.current = restIndex;
      setIndex(restIndex);
      return;
    }

    const delays = new Array<number>(frameCount).fill(1000 / fps);
    if (durationKey) {
      durationKey.split(":").forEach((raw, i) => {
        const value = Number(raw);
        if (Number.isFinite(value) && value >= 0) {
          delays[i] = value;
        }
      });
    }
    const total = delays.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
      indexRef.current = restIndex;
      setIndex(restIndex);
      return;
    }

    let rafId = 0;
    const startedAt = performance.now();

    const resolveIndex = (elapsed: number): number => {
      if (!loop && elapsed >= total) {
        return -1;
      }
      let rest = elapsed % total;
      for (let i = 0; i < frameCount; i += 1) {
        rest -= delays[i];
        if (rest < 0) {
          return i;
        }
      }
      return frameCount - 1;
    };

    const tick = (now: number): void => {
      const next = resolveIndex(now - startedAt);
      const target = next === -1 ? frameCount - 1 : next;
      if (target !== indexRef.current) {
        indexRef.current = target;
        setIndex(target);
      }
      if (next !== -1) {
        rafId = requestAnimationFrame(tick);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [active, durationKey, fps, frameCount, loop, restIndex]);

  return index;
};

export function IconFramePlayer({
  frames,
  size = 16,
  viewBox = "0 0 24 24",
  strokeWidth = 1.8,
  fps = 12,
  durations,
  loop = true,
  playing,
  hoverPlay = false,
  hoverScope,
  restFrame = "first",
  className,
}: IconFramePlayerProps): JSX.Element | null {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [reducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  const frameCount = frames.length;
  const restIndex = restFrame === "last" ? Math.max(frameCount - 1, 0) : 0;
  const active =
    playing ?? (hoverPlay ? hovered && !reducedMotion : !reducedMotion);
  const index = useFrameIndex(
    frameCount,
    fps,
    durations,
    active,
    loop,
    restIndex,
  );

  useEffect(() => {
    if (!hoverPlay) {
      return;
    }
    const node = svgRef.current;
    if (!node) {
      return;
    }
    const target = (hoverScope ? node.closest(hoverScope) : null) ?? node;
    const enter = (): void => setHovered(true);
    const leave = (): void => setHovered(false);
    target.addEventListener("mouseenter", enter);
    target.addEventListener("mouseleave", leave);
    target.addEventListener("focusin", enter);
    target.addEventListener("focusout", leave);
    return () => {
      target.removeEventListener("mouseenter", enter);
      target.removeEventListener("mouseleave", leave);
      target.removeEventListener("focusin", enter);
      target.removeEventListener("focusout", leave);
    };
  }, [hoverPlay, hoverScope]);

  if (frameCount === 0) {
    return null;
  }

  return (
    <svg
      ref={svgRef}
      className={
        className ? `icon-frame-player ${className}` : "icon-frame-player"
      }
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {frames[Math.min(index, frameCount - 1)]}
    </svg>
  );
}
