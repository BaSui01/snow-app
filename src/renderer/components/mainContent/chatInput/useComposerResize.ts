import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";

/** 编辑器可拖拽高度下限（两行） */
const MIN_EDITOR_HEIGHT = 40;
/** 键盘微调步长 */
const KEYBOARD_STEP = 24;
/** 越过上限后需额外拖动的原始距离才进入撑满，避免误触 */
const EXPAND_TRIGGER_DISTANCE = 64;
/** 上限外的橡皮筋阻尼与最大回弹高度 */
const OVERSHOOT_DAMPING = 0.2;
const OVERSHOOT_MAX = 12;
/** 撑满/收起过渡时长 */
const TRANSITION_MS = 200;
/** 手动高度上限：聊天区高度占比与绝对上限 */
const MAX_EDITOR_RATIO = 0.55;
const MAX_EDITOR_CAP = 560;
/** 双击复位判定间隔 */
const DOUBLE_TAP_MS = 320;

type ComposerPhase = "inline" | "expanded";

type ComposerMetrics = {
  maxEditorHeight: number;
  /** 撑满状态下允许收缩到的最小输入区高度 */
  minPanelHeight: number;
  /** 内联布局下（编辑器到上限时）输入区高度 */
  inlineMaxPanelHeight: number;
  /** 撑满时输入区高度 */
  fullPanelHeight: number;
  /** 当前用来抵消撑满布局占位的输入区高度 */
  reservedPanelHeight: number;
};

type ResizeDragState = {
  pointerId: number;
  moved: boolean;
  phase: ComposerPhase;
  /** 起始指针 Y：内联阶段为拖拽起点 */
  startY: number;
  /** 最近一次已消费的指针 Y：撑满阶段做增量计算 */
  lastY: number;
  /** 内联阶段起始编辑器高度 */
  startEditorHeight: number;
  maxEditorHeight: number;
};

export type ComposerResizeApi = {
  inputAreaRef: RefObject<HTMLDivElement | null>;
  composerExpanded: boolean;
  isResizing: boolean;
  collapseComposer: () => void;
  handleResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleResizePointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleResizePointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleResizeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * 输入区高度：拖拽顶部把手调整编辑器高度，越过上限后继续上拖（带阻尼与
 * 触发距离）可撑满整个聊天区；撑满后向下拖可一路缩回小高度，无需松手。
 * 全程跟随指针，松手时才按进度贴齐撑满或收回。
 */
export const useComposerResize = ({
  textareaRef,
}: {
  textareaRef: RefObject<HTMLDivElement | null>;
}): ComposerResizeApi => {
  const inputAreaRef = useRef<HTMLDivElement | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const composerExpandedRef = useRef(false);
  const manualHeightRef = useRef<number | null>(null);
  const metricsRef = useRef<ComposerMetrics | null>(null);
  const dragRef = useRef<ResizeDragState | null>(null);
  /** 撑满状态下输入区当前高度 */
  const panelHeightRef = useRef(0);
  const tweenRef = useRef<number | null>(null);
  const moveFrameRef = useRef<number | null>(null);
  const pendingYRef = useRef<number | null>(null);
  const lastTapTimeRef = useRef(0);
  const lastTapWasClickRef = useRef(false);
  /** 等撑满样式类移除后再清显式高度，避免中途布局塌陷造成闪烁 */
  const pendingStyleResetRef = useRef(false);

  const cancelTween = useCallback((): void => {
    if (tweenRef.current !== null) {
      cancelAnimationFrame(tweenRef.current);
      tweenRef.current = null;
    }
  }, []);

  const cancelMoveFrame = useCallback((): void => {
    pendingYRef.current = null;
    if (moveFrameRef.current !== null) {
      cancelAnimationFrame(moveFrameRef.current);
      moveFrameRef.current = null;
    }
  }, []);

  const measureEditorHeight = useCallback((): number => {
    const element = textareaRef.current;
    return element ? element.getBoundingClientRect().height : 0;
  }, [textareaRef]);

  /** 输入区所在聊天列（.chat-content） */
  const getChatContent = useCallback((): HTMLElement | null => {
    const region = inputAreaRef.current?.parentElement;
    const content = region?.parentElement;
    return content instanceof HTMLElement ? content : null;
  }, []);

  const measureMaxEditorHeight = useCallback((): number => {
    const content = getChatContent();
    const available = content
      ? content.getBoundingClientRect().height
      : window.innerHeight;
    return Math.max(
      MIN_EDITOR_HEIGHT + 120,
      Math.min(available * MAX_EDITOR_RATIO, MAX_EDITOR_CAP),
    );
  }, [getChatContent]);

  const focusEditor = useCallback((): void => {
    textareaRef.current?.focus({ preventScroll: true });
  }, [textareaRef]);

  const markAtMax = useCallback((atMax: boolean): void => {
    const area = inputAreaRef.current;
    if (!area) return;
    if (atMax) {
      area.dataset.resizeAtMax = "true";
    } else {
      area.removeAttribute("data-resize-at-max");
    }
  }, []);

  /** 手动高度写在编辑器自身：只影响编辑器子树，避免整块输入区重算样式 */
  const applyManualHeight = useCallback(
    (height: number | null): void => {
      const element = textareaRef.current;
      const next = height === null ? null : Math.round(height);
      manualHeightRef.current = next;
      if (!element) return;
      if (next === null) {
        element.style.removeProperty("--chat-input-manual-height");
        return;
      }
      element.style.setProperty("--chat-input-manual-height", `${next}px`);
    },
    [textareaRef],
  );

  /** 测量编辑器按内容自动伸缩时的高度（内联默认高度） */
  const measureAutoEditorHeight = useCallback((): number => {
    const element = textareaRef.current;
    if (!element) return MIN_EDITOR_HEIGHT;
    const { style } = element;
    const previousFlex = style.getPropertyValue("flex");
    const previousHeight = style.getPropertyValue("height");
    const previousMaxHeight = style.getPropertyValue("max-height");
    const previousMinHeight = style.getPropertyValue("min-height");
    style.setProperty("flex", "0 0 auto");
    style.setProperty("height", "auto");
    style.setProperty("max-height", "160px");
    style.setProperty("min-height", `${MIN_EDITOR_HEIGHT}px`);
    const height = element.getBoundingClientRect().height;
    if (previousFlex) style.setProperty("flex", previousFlex);
    else style.removeProperty("flex");
    if (previousHeight) style.setProperty("height", previousHeight);
    else style.removeProperty("height");
    if (previousMaxHeight) style.setProperty("max-height", previousMaxHeight);
    else style.removeProperty("max-height");
    if (previousMinHeight) style.setProperty("min-height", previousMinHeight);
    else style.removeProperty("min-height");
    return height > 0 ? height : MIN_EDITOR_HEIGHT;
  }, [textareaRef]);

  const applyPanelHeight = useCallback(
    (height: number, reservedHeight?: number): void => {
      const area = inputAreaRef.current;
      const metrics = metricsRef.current;
      if (!area || !metrics) return;
      const reserved = reservedHeight ?? metrics.reservedPanelHeight;
      const next = clamp(
        height,
        metrics.minPanelHeight,
        metrics.fullPanelHeight,
      );
      panelHeightRef.current = next;
      metrics.reservedPanelHeight = reserved;
      area.style.height = `${next}px`;
      area.style.marginTop = `${reserved - next}px`;
    },
    [],
  );

  const resetExpandedStyles = useCallback((): void => {
    const area = inputAreaRef.current;
    panelHeightRef.current = 0;
    if (!area) return;
    area.style.removeProperty("height");
    area.style.removeProperty("margin-top");
  }, []);

  const animatePanelHeight = useCallback(
    (
      from: number,
      to: number,
      durationMs: number,
      onDone?: () => void,
      fromReserved?: number,
      toReserved?: number,
    ): void => {
      cancelTween();
      const reservedFrom =
        fromReserved ?? metricsRef.current?.reservedPanelHeight ?? 0;
      const reservedTo = toReserved ?? reservedFrom;
      if (durationMs <= 0 || Math.abs(to - from) < 0.5) {
        applyPanelHeight(to, reservedTo);
        onDone?.();
        return;
      }
      const startTime = performance.now();
      const diff = to - from;
      const reservedDiff = reservedTo - reservedFrom;
      const step = (now: number): void => {
        const progress = Math.min(1, (now - startTime) / durationMs);
        const eased = 1 - Math.pow(1 - progress, 3);
        applyPanelHeight(
          from + diff * eased,
          reservedFrom + reservedDiff * eased,
        );
        if (progress < 1) {
          tweenRef.current = requestAnimationFrame(step);
          return;
        }
        tweenRef.current = null;
        onDone?.();
      };
      tweenRef.current = requestAnimationFrame(step);
    },
    [applyPanelHeight, cancelTween],
  );

  const finishCollapse = useCallback((): void => {
    // 先摘样式类，显式高度交给 layout effect 同帧清理：
    // 先清高度会让撑满布局瞬间塌陷，表现为会话页闪一下
    inputAreaRef.current?.removeAttribute("data-composer-collapsing");
    pendingStyleResetRef.current = true;
    setComposerExpanded(false);
    markAtMax(false);
    requestAnimationFrame(focusEditor);
  }, [focusEditor, markAtMax]);

  const collapseComposer = useCallback((): void => {
    const metrics = metricsRef.current;
    if (!metrics || !composerExpandedRef.current) return;
    // 收起时结束进行中的拖拽，避免手势与动画互相抢高度
    if (dragRef.current) {
      dragRef.current = null;
      setIsResizing(false);
      cancelMoveFrame();
    }
    composerExpandedRef.current = false;
    // 回到默认高度（内容自动高度），而不是手动上限
    applyManualHeight(null);
    const chromeHeight = Math.max(
      0,
      metrics.inlineMaxPanelHeight - metrics.maxEditorHeight,
    );
    const targetPanelHeight = Math.min(
      metrics.fullPanelHeight,
      Math.max(
        metrics.minPanelHeight,
        chromeHeight + measureAutoEditorHeight(),
      ),
    );
    inputAreaRef.current?.setAttribute("data-composer-collapsing", "true");
    animatePanelHeight(
      panelHeightRef.current,
      targetPanelHeight,
      TRANSITION_MS,
      () => {
        if (composerExpandedRef.current) return;
        finishCollapse();
      },
      metrics.reservedPanelHeight,
      targetPanelHeight,
    );
  }, [
    animatePanelHeight,
    applyManualHeight,
    cancelMoveFrame,
    finishCollapse,
    measureAutoEditorHeight,
  ]);

  /** 从内联态进入撑满：记录布局基准并切换撑满样式（不含动画） */
  const beginExpanded = useCallback(
    (maxEditorHeight: number): boolean => {
      const area = inputAreaRef.current;
      const content = getChatContent();
      if (!area || !content || composerExpandedRef.current) return false;
      const reservedPanelHeight = area.getBoundingClientRect().height;
      const fullPanelHeight = content.getBoundingClientRect().height;
      if (fullPanelHeight <= reservedPanelHeight + 32) return false;
      const chromeHeight = Math.max(
        0,
        reservedPanelHeight - measureEditorHeight(),
      );
      metricsRef.current = {
        maxEditorHeight,
        minPanelHeight: Math.max(48, chromeHeight + MIN_EDITOR_HEIGHT),
        inlineMaxPanelHeight: chromeHeight + maxEditorHeight,
        fullPanelHeight,
        reservedPanelHeight,
      };
      area.removeAttribute("data-composer-collapsing");
      composerExpandedRef.current = true;
      setComposerExpanded(true);
      applyManualHeight(maxEditorHeight);
      applyPanelHeight(reservedPanelHeight);
      return true;
    },
    [applyManualHeight, applyPanelHeight, getChatContent, measureEditorHeight],
  );

  /** 按指针位置推进拖拽：内联 ↔ 撑满 全程跟随，不依赖动画 */
  const applyDragY = useCallback(
    (clientY: number): void => {
      const drag = dragRef.current;
      if (!drag) return;

      if (drag.phase === "expanded") {
        const metrics = metricsRef.current;
        if (!metrics) return;
        const delta = drag.lastY - clientY;
        drag.lastY = clientY;
        if (delta === 0) return;
        // 展开动画进行中的轻微回拖不打断，避免抖动抢走动画
        if (tweenRef.current !== null) {
          if (delta > -4) return;
          cancelTween();
        }
        const desired = panelHeightRef.current + delta;
        if (desired <= metrics.inlineMaxPanelHeight) {
          // 回到内联高度后交还普通拖拽，同一手势继续缩小。
          // 先保持显式高度并摘样式类，清理交给 layout effect，避免闪一下
          composerExpandedRef.current = false;
          applyManualHeight(metrics.maxEditorHeight);
          applyPanelHeight(metrics.inlineMaxPanelHeight);
          pendingStyleResetRef.current = true;
          setComposerExpanded(false);
          drag.phase = "inline";
          drag.startY = clientY;
          drag.startEditorHeight = metrics.maxEditorHeight;
          return;
        }
        applyPanelHeight(desired);
        return;
      }

      const desired = drag.startEditorHeight + (drag.startY - clientY);
      if (desired <= drag.maxEditorHeight) {
        markAtMax(false);
        applyManualHeight(Math.max(MIN_EDITOR_HEIGHT, desired));
        return;
      }
      const overshoot = desired - drag.maxEditorHeight;
      if (overshoot >= EXPAND_TRIGGER_DISTANCE) {
        if (beginExpanded(drag.maxEditorHeight)) {
          drag.phase = "expanded";
          drag.lastY = clientY;
          markAtMax(false);
          const fullPanelHeight = metricsRef.current?.fullPanelHeight;
          if (fullPanelHeight) {
            animatePanelHeight(
              panelHeightRef.current,
              fullPanelHeight,
              TRANSITION_MS,
            );
          }
          return;
        }
        applyManualHeight(drag.maxEditorHeight);
        markAtMax(false);
        return;
      }
      // 上限外橡皮筋：阻尼增长并提示继续上拖
      markAtMax(true);
      applyManualHeight(
        drag.maxEditorHeight +
          Math.min(overshoot * OVERSHOOT_DAMPING, OVERSHOOT_MAX),
      );
    },
    [
      animatePanelHeight,
      applyManualHeight,
      applyPanelHeight,
      beginExpanded,
      cancelTween,
      markAtMax,
    ],
  );

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0 || dragRef.current) return;
      event.preventDefault();
      const now = performance.now();
      const isDoubleTap =
        lastTapWasClickRef.current &&
        now - lastTapTimeRef.current < DOUBLE_TAP_MS;
      lastTapTimeRef.current = now;
      lastTapWasClickRef.current = false;
      if (isDoubleTap) {
        if (composerExpandedRef.current) {
          collapseComposer();
        } else {
          applyManualHeight(null);
        }
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      const area = inputAreaRef.current;
      // 收起动画进行中重新按住把手：恢复展开态由手势接管
      const visuallyExpanded =
        composerExpandedRef.current ||
        (area?.classList.contains("is-composer-expanded") ?? false);
      if (visuallyExpanded) {
        composerExpandedRef.current = true;
        area?.removeAttribute("data-composer-collapsing");
        cancelTween();
      }
      cancelMoveFrame();
      dragRef.current = {
        pointerId: event.pointerId,
        moved: false,
        phase: visuallyExpanded ? "expanded" : "inline",
        startY: event.clientY,
        lastY: event.clientY,
        startEditorHeight: measureEditorHeight(),
        maxEditorHeight: measureMaxEditorHeight(),
      };
      setIsResizing(true);
    },
    [
      applyManualHeight,
      cancelMoveFrame,
      cancelTween,
      collapseComposer,
      measureEditorHeight,
      measureMaxEditorHeight,
    ],
  );

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.moved = true;
      lastTapWasClickRef.current = false;
      pendingYRef.current = event.clientY;
      if (moveFrameRef.current !== null) return;
      moveFrameRef.current = requestAnimationFrame(() => {
        moveFrameRef.current = null;
        const y = pendingYRef.current;
        pendingYRef.current = null;
        if (y !== null) applyDragY(y);
      });
    },
    [applyDragY],
  );

  const handleResizePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      // 收尾前补上最后一帧未消费的指针位置
      const pendingY = pendingYRef.current;
      cancelMoveFrame();
      if (pendingY !== null) applyDragY(pendingY);
      dragRef.current = null;
      setIsResizing(false);
      markAtMax(false);
      lastTapWasClickRef.current = event.type === "pointerup" && !drag.moved;
      lastTapTimeRef.current = performance.now();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      // 撑满态保持当前高度（自动展开动画继续跑完），松手不回弹
      if (composerExpandedRef.current) return;
      // 松手时把橡皮筋回弹到上限
      const maxHeight = drag.maxEditorHeight;
      if ((manualHeightRef.current ?? 0) > maxHeight) {
        applyManualHeight(maxHeight);
      }
    },
    [applyDragY, applyManualHeight, cancelMoveFrame, markAtMax],
  );

  const handleResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      if (composerExpandedRef.current) {
        if (event.key === "ArrowDown") {
          collapseComposer();
        }
        return;
      }
      const maxHeight = measureMaxEditorHeight();
      const current = manualHeightRef.current ?? measureEditorHeight();
      if (event.key === "ArrowUp") {
        if (current >= maxHeight - 1) {
          if (beginExpanded(maxHeight)) {
            const fullPanelHeight = metricsRef.current?.fullPanelHeight;
            if (fullPanelHeight) {
              animatePanelHeight(
                panelHeightRef.current,
                fullPanelHeight,
                TRANSITION_MS,
              );
            }
          }
          return;
        }
        applyManualHeight(Math.min(maxHeight, current + KEYBOARD_STEP));
        return;
      }
      applyManualHeight(Math.max(MIN_EDITOR_HEIGHT, current - KEYBOARD_STEP));
    },
    [
      animatePanelHeight,
      applyManualHeight,
      beginExpanded,
      collapseComposer,
      measureEditorHeight,
      measureMaxEditorHeight,
    ],
  );

  // 撑满样式类移除后，在同一帧内清掉显式高度：此时内容高度与之一致，
  // 不会出现“布局塌陷 → 再撑开”的闪烁
  useLayoutEffect(() => {
    if (composerExpanded || !pendingStyleResetRef.current) return;
    pendingStyleResetRef.current = false;
    resetExpandedStyles();
  }, [composerExpanded, resetExpandedStyles]);

  // Esc 收起：行内弹窗 / 模态框占用 Esc 时不抢
  useEffect(() => {
    if (!composerExpanded) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          ".app-modal-overlay, .file-mention-popup, .chat-command-panel, .rollback-picker-popup",
        )
      ) {
        return;
      }
      collapseComposer();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [collapseComposer, composerExpanded]);

  // 窗口尺寸变化时按新高度重算，避免撑满后留下空隙
  useEffect(() => {
    if (!composerExpanded) return;
    const handleWindowResize = (): void => {
      const content = getChatContent();
      const metrics = metricsRef.current;
      if (!content || !metrics) return;
      const fullPanelHeight = content.getBoundingClientRect().height;
      if (fullPanelHeight <= metrics.reservedPanelHeight + 32) {
        collapseComposer();
        return;
      }
      const wasFull = panelHeightRef.current >= metrics.fullPanelHeight - 1;
      metrics.fullPanelHeight = fullPanelHeight;
      applyPanelHeight(
        wasFull
          ? fullPanelHeight
          : Math.min(panelHeightRef.current, fullPanelHeight),
      );
    };
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [applyPanelHeight, collapseComposer, composerExpanded, getChatContent]);

  useEffect(
    () => () => {
      cancelTween();
      cancelMoveFrame();
    },
    [cancelMoveFrame, cancelTween],
  );

  return {
    inputAreaRef,
    composerExpanded,
    isResizing,
    collapseComposer,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerUp,
    handleResizeKeyDown,
  };
};
