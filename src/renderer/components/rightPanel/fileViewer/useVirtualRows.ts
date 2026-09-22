import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

const OVERSCAN_ROWS = 24;
const DEFAULT_VIEWPORT_ROWS = 40;
const FALLBACK_ROW_HEIGHT = 20;

export type VirtualRange = { start: number; end: number };

export const useVirtualRows = (
  scrollRef: RefObject<HTMLElement | null>,
  totalRows: number,
  rowHeight: number,
): { range: VirtualRange; syncRange: () => void } => {
  const height = rowHeight > 0 ? rowHeight : FALLBACK_ROW_HEIGHT;
  const total = Math.max(0, totalRows);
  const [range, setRange] = useState<VirtualRange>(() => ({
    start: 0,
    end: Math.min(total, DEFAULT_VIEWPORT_ROWS + OVERSCAN_ROWS * 2),
  }));

  const compute = useCallback(
    (viewportHeight: number, scrollTop: number): VirtualRange => {
      if (total <= 0) return { start: 0, end: 0 };
      const visible = Math.max(1, Math.ceil(viewportHeight / height));
      const start = Math.min(
        Math.max(0, Math.floor(scrollTop / height) - OVERSCAN_ROWS),
        total - 1,
      );
      const end = Math.min(total, start + visible + OVERSCAN_ROWS * 2);
      return { start, end };
    },
    [height, total],
  );

  const syncRange = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const next = compute(element.clientHeight, element.scrollTop);
    setRange((prev) =>
      prev.start === next.start && prev.end === next.end ? prev : next,
    );
  }, [compute, scrollRef]);

  // 滚动容器可能在模式切换时重建（如退出编辑模式）：元素变化时重新绑定监听。
  const attachedRef = useRef<HTMLElement | null>(null);
  const [attachTick, setAttachTick] = useState(0);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === attachedRef.current) return;
    attachedRef.current = element;
    setAttachTick((prev) => prev + 1);
  });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const next = compute(element.clientHeight, element.scrollTop);
        setRange((prev) =>
          prev.start === next.start && prev.end === next.end ? prev : next,
        );
      });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    element.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener("scroll", schedule);
    };
  }, [attachTick, compute, scrollRef]);

  return { range, syncRange };
};
