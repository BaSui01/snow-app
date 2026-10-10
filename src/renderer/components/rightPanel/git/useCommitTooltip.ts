import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { GitLogEntry } from "../../../../preload";

/** 悬停提交行后延迟弹出详情面板（毫秒），短暂途经的行不会误触；面板已
 *  可见时在行 / 面板之间切换悬停属于有意浏览，不受该延迟限制。 */
const TOOLTIP_SHOW_DELAY = 400;

/**
 * Hover tooltip with the full commit details. Rendered in a portal with
 * fixed positioning so the scroll container (.git-control-scroll) cannot
 * clip it, and anchored to the hovered row: vertically centered on that
 * row, opening towards whichever side has room, with an arrow pointing
 * back at the row it belongs to.
 */
export function useCommitTooltip() {
  const [hoveredCommit, setHoveredCommit] = useState<GitLogEntry | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // 悬停锚点：被悬停的提交行元素。
  const tooltipAnchorRef = useRef<HTMLElement | null>(null);

  /**
   * 面板贴着悬停行定位：纵向与行中心对齐（越界时夹紧在视口内），横向优先
   * 落在空间更大的一侧，箭头始终指向该行。位置直接写在 DOM 上（不触发重渲染）。
   */
  const positionTooltip = useCallback(() => {
    const node = tooltipRef.current;
    const anchor = tooltipAnchorRef.current;
    if (!node || !anchor) return;
    const margin = 12;
    const gap = 10;
    const rect = node.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const anchorCenterY = anchorRect.top + anchorRect.height / 2;
    const maxTop = Math.max(vh - rect.height - margin, margin);
    const top = Math.min(
      Math.max(anchorCenterY - rect.height / 2, margin),
      maxTop,
    );

    // data-side 表示箭头所在的面板边缘：left 即面板贴在行的右侧。
    let arrowSide: "left" | "right" = "left";
    let left = anchorRect.right + gap;
    if (
      left + rect.width > vw - margin &&
      anchorRect.left - rect.width - gap >= margin
    ) {
      left = anchorRect.left - rect.width - gap;
      arrowSide = "right";
    }
    left = Math.max(margin, Math.min(left, vw - rect.width - margin));

    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.dataset.side = arrowSide;
    // 箭头对准行中心，同时保证完整落在面板边缘内。
    const arrowTop = Math.min(
      Math.max(anchorCenterY - top, 14),
      Math.max(rect.height - 14, 14),
    );
    node.style.setProperty("--tooltip-arrow-top", `${arrowTop}px`);
  }, []);

  // 面板可交互（提交说明可能带滚动条），所以指针离开提交行后延迟隐藏，
  // 留出移动到面板的间隙；指针进入面板即取消隐藏。
  const tooltipHideTimerRef = useRef<number | null>(null);
  // 首次悬停的延迟出现定时器：行上停留够久才弹出面板，途经行不误触。
  const tooltipShowTimerRef = useRef<number | null>(null);
  // 面板是否已可见：可见时在行 / 面板之间切换悬停属于有意浏览，立即跟随。
  const tooltipVisibleRef = useRef(false);

  const cancelHideTooltip = useCallback(() => {
    if (tooltipHideTimerRef.current !== null) {
      window.clearTimeout(tooltipHideTimerRef.current);
      tooltipHideTimerRef.current = null;
    }
  }, []);

  const cancelShowTooltip = useCallback(() => {
    if (tooltipShowTimerRef.current !== null) {
      window.clearTimeout(tooltipShowTimerRef.current);
      tooltipShowTimerRef.current = null;
    }
  }, []);

  const applyTooltip = useCallback(
    (commit: GitLogEntry, anchor: HTMLElement) => {
      cancelShowTooltip();
      cancelHideTooltip();
      tooltipVisibleRef.current = true;
      tooltipAnchorRef.current = anchor;
      // Skip the re-render when hovering within the same commit.
      setHoveredCommit((prev) => (prev === commit ? prev : commit));
    },
    [cancelHideTooltip, cancelShowTooltip],
  );

  const showTooltip = useCallback(
    (commit: GitLogEntry, anchor: HTMLElement) => {
      cancelHideTooltip();
      // 面板已可见：连续浏览中切换行，立即应用；从静止状态首次悬停才延迟。
      if (tooltipVisibleRef.current) {
        applyTooltip(commit, anchor);
        return;
      }
      cancelShowTooltip();
      tooltipShowTimerRef.current = window.setTimeout(() => {
        tooltipShowTimerRef.current = null;
        applyTooltip(commit, anchor);
      }, TOOLTIP_SHOW_DELAY);
    },
    [applyTooltip, cancelHideTooltip, cancelShowTooltip],
  );

  const hideTooltip = useCallback(() => {
    cancelShowTooltip();
    cancelHideTooltip();
    tooltipVisibleRef.current = false;
    setHoveredCommit(null);
  }, [cancelHideTooltip, cancelShowTooltip]);

  const scheduleHideTooltip = useCallback(() => {
    cancelShowTooltip();
    cancelHideTooltip();
    tooltipHideTimerRef.current = window.setTimeout(() => {
      tooltipHideTimerRef.current = null;
      tooltipVisibleRef.current = false;
      setHoveredCommit(null);
    }, 240);
  }, [cancelHideTooltip, cancelShowTooltip]);

  useEffect(
    () => () => {
      cancelShowTooltip();
      cancelHideTooltip();
    },
    [cancelShowTooltip, cancelHideTooltip],
  );

  // 首次定位在布局阶段完成（绘制前就位，不会闪到默认位置）。
  useLayoutEffect(() => {
    if (!hoveredCommit) return;
    positionTooltip();
  }, [hoveredCommit, positionTooltip]);

  // 面板打开期间跟随行的滚动 / 窗口尺寸变化重新定位。
  useEffect(() => {
    if (!hoveredCommit) return;
    const reposition = () => positionTooltip();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [hoveredCommit, positionTooltip]);

  // 卡片内容异步补全（如改动文件数载入）会改变高度，尺寸变化后重新贴合
  // 悬停行；positionTooltip 只改 left / top，不会反过来触发尺寸变化。
  useEffect(() => {
    if (!hoveredCommit) return;
    const node = tooltipRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => positionTooltip());
    observer.observe(node);
    return () => observer.disconnect();
  }, [hoveredCommit, positionTooltip]);

  return {
    hoveredCommit,
    tooltipRef,
    cancelHideTooltip,
    cancelShowTooltip,
    showTooltip,
    hideTooltip,
    scheduleHideTooltip,
  };
}
