import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** 左栏最小宽度（px）。 */
const MIN_SPLIT_WIDTH = 220;
/** 拖拽时必须给右侧内容区保留的最小宽度（px）。 */
const MIN_CONTENT_WIDTH = 240;

type SplitResizeOptions = {
  /** 承载左栏宽度的 CSS 变量名，如 "--memo-split-width"。 */
  variableName: string;
  /** localStorage 键名，用于记住拖拽后的宽度。 */
  storageKey: string;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  minContentWidth?: number;
};

type SplitResizeResult = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  width: number;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
};

const readStoredWidth = (storageKey: string, fallback: number): number => {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw === null ? Number.NaN : Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const writeStoredWidth = (storageKey: string, width: number): void => {
  try {
    window.localStorage.setItem(storageKey, String(Math.round(width)));
  } catch {
    // 存储不可用时忽略：宽度在当前会话内仍然生效
  }
};

/**
 * 双栏页面的中轴拖拽：把左栏宽度写进 CSS 变量并持久化到 localStorage。
 * 拖拽期间直接改 DOM 变量（不触发 React 重渲染），松手后一次性提交状态。
 */
export const useSplitResize = ({
  variableName,
  storageKey,
  defaultWidth,
  minWidth = MIN_SPLIT_WIDTH,
  maxWidth,
  minContentWidth = MIN_CONTENT_WIDTH,
}: SplitResizeOptions): SplitResizeResult => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(() =>
    readStoredWidth(storageKey, defaultWidth),
  );

  const clampWidth = useCallback(
    (next: number): number => {
      const container = containerRef.current;
      const available = container
        ? container.getBoundingClientRect().width - minContentWidth
        : Number.POSITIVE_INFINITY;
      const upper =
        maxWidth === undefined ? available : Math.min(maxWidth, available);
      return Math.round(
        Math.min(Math.max(next, minWidth), Math.max(minWidth, upper)),
      );
    },
    [maxWidth, minContentWidth, minWidth],
  );

  // 容器尺寸变化（窗口缩放）后收回合法范围，避免内容区被挤没
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      setWidth((prev) => {
        const next = clampWidth(prev);
        return next === prev ? prev : next;
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [clampWidth]);

  const onResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const container = containerRef.current;
      if (!container) return;
      event.preventDefault();

      const resizerElement = event.currentTarget;
      const startX = event.clientX;
      const startWidth = width;
      let latestWidth = width;

      const applyWidth = (value: number): void => {
        container.style.setProperty(variableName, `${value}px`);
      };

      const handlePointerMove = (pointerEvent: PointerEvent): void => {
        latestWidth = clampWidth(startWidth + pointerEvent.clientX - startX);
        applyWidth(latestWidth);
      };

      const stopResize = (): void => {
        document.body.classList.remove("is-panel-resizing");
        resizerElement.classList.remove("is-active");
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", stopResize);
        document.removeEventListener("pointercancel", stopResize);
        resizerElement.removeEventListener("lostpointercapture", stopResize);
        applyWidth(latestWidth);
        writeStoredWidth(storageKey, latestWidth);
        setWidth(latestWidth);
      };

      document.body.classList.add("is-panel-resizing");
      resizerElement.classList.add("is-active");
      resizerElement.setPointerCapture(event.pointerId);
      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", stopResize);
      document.addEventListener("pointercancel", stopResize);
      resizerElement.addEventListener("lostpointercapture", stopResize);
    },
    [clampWidth, storageKey, variableName, width],
  );

  return { containerRef, width, onResizeStart };
};
