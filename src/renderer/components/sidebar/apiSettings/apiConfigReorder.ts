import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { ApiConfigRecord } from "../../../../preload";

/** 拖拽落点：放到目标项之前 / 之后。 */
export type ApiConfigDropPlacement = "before" | "after";

/** 拖拽数据里写入的自定义类型，避免与文件、会话等其它拖拽源互相干扰。 */
const API_CONFIG_DRAG_TYPE = "application/x-snow-api-config";

/** 表格行上的档案名标记，自动滚动后据此重新判定悬停落点。 */
export const API_CONFIG_ROW_ATTRIBUTE = "data-api-config-row";

/** 拖拽时距离滚动容器上下边缘多近开始自动滚动（像素）。 */
const AUTO_SCROLL_EDGE = 52;

/** 自动滚动每帧的最大位移（像素）。 */
const AUTO_SCROLL_MAX_STEP = 20;

/** 找到离拖拽行最近的可纵向滚动的祖先容器。 */
const findScrollableAncestor = (
  element: Element | null,
): HTMLElement | null => {
  let current = element instanceof HTMLElement ? element : null;
  while (current) {
    const { overflowY } = window.getComputedStyle(current);
    const scrollable =
      (overflowY === "auto" ||
        overflowY === "scroll" ||
        overflowY === "overlay") &&
      current.scrollHeight - current.clientHeight > 1;
    if (scrollable) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
};

type ApiConfigAutoScrollState = {
  container: HTMLElement;
  sourceName: string;
  pointerX: number;
  pointerY: number;
  frame: number | null;
};

/**
 * 把 `sourceName` 移动到 `targetName` 的前 / 后，返回新的完整顺序。
 * 名称不存在或位置没有变化时原样返回入参（调用方可据引用判断是否落库）。
 */
export const moveApiConfigName = (
  names: readonly string[],
  sourceName: string,
  targetName: string,
  placement: ApiConfigDropPlacement,
): readonly string[] => {
  const sourceIndex = names.indexOf(sourceName);
  const targetIndex = names.indexOf(targetName);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return names;
  }

  const remaining = names.filter((name) => name !== sourceName);
  const insertIndex =
    placement === "before"
      ? remaining.indexOf(targetName)
      : remaining.indexOf(targetName) + 1;

  return [
    ...remaining.slice(0, insertIndex),
    sourceName,
    ...remaining.slice(insertIndex),
  ];
};

/** 按名称顺序重排配置列表；未列出的配置保持相对顺序排在末尾。 */
export const orderApiConfigsByName = (
  configs: readonly ApiConfigRecord[],
  orderedNames: readonly string[],
): ApiConfigRecord[] => {
  const remaining = new Map(
    configs.map((config) => [config.profileName, config]),
  );
  const ordered: ApiConfigRecord[] = [];

  for (const name of orderedNames) {
    const config = remaining.get(name);
    if (config) {
      remaining.delete(name);
      ordered.push(config);
    }
  }
  for (const config of configs) {
    if (remaining.has(config.profileName)) {
      ordered.push(config);
    }
  }

  return ordered;
};

export type ApiConfigDragHandleProps = {
  draggable: true;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
};

export type ApiConfigDropTargetProps = {
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
};

export type ApiConfigReorderController = {
  /** 正在拖拽的档案名；没有拖拽时为 null。 */
  draggingName: string | null;
  /** 拖拽悬停的目标档案名；没有悬停时为 null。 */
  dropTargetName: string | null;
  /** 悬停落点，与 dropTargetName 同步。 */
  dropPlacement: ApiConfigDropPlacement | null;
  canMoveUp: (name: string) => boolean;
  canMoveDown: (name: string) => boolean;
  moveUp: (name: string) => void;
  moveDown: (name: string) => void;
  getDragHandleProps: (name: string) => ApiConfigDragHandleProps;
  getDropTargetProps: (name: string) => ApiConfigDropTargetProps;
};

type ApiConfigReorderOptions = {
  /** 完整顺序（未过滤）的档案名，重排以此为基准。 */
  allNames: readonly string[];
  /** 当前展示（过滤后）的档案名；拖拽落点与上移下移都相对可见项计算。 */
  visibleNames: readonly string[];
  /** 提交新的完整顺序，由调用方负责持久化与状态更新。 */
  onReorder: (orderedNames: string[]) => void;
};

type ApiConfigDragState = {
  sourceName: string;
  targetName: string | null;
  placement: ApiConfigDropPlacement | null;
};

/**
 * API 档案排序交互（HTML5 拖拽 + 上移 / 下移）：
 * 只维护拖拽过程中的高亮状态，真正的顺序计算与持久化交给调用方。
 */
export const useApiConfigReorder = ({
  allNames,
  visibleNames,
  onReorder,
}: ApiConfigReorderOptions): ApiConfigReorderController => {
  const [dragState, setDragState] = useState<ApiConfigDragState | null>(null);
  const autoScrollRef = useRef<ApiConfigAutoScrollState | null>(null);
  const visibleNamesRef = useRef(visibleNames);

  useEffect(() => {
    visibleNamesRef.current = visibleNames;
  }, [visibleNames]);

  /** 停止边缘自动滚动；重复调用安全。 */
  const stopAutoScroll = useCallback(() => {
    const state = autoScrollRef.current;
    if (!state) {
      return;
    }
    if (state.frame !== null) {
      cancelAnimationFrame(state.frame);
    }
    autoScrollRef.current = null;
  }, []);

  /** 内容滚动后鼠标下的行会变化，主动同步落点，避免高亮停在旧行。 */
  const syncDropTargetFromPointer = useCallback(
    (sourceName: string, elementUnderPointer: Element) => {
      const row = elementUnderPointer.closest(`[${API_CONFIG_ROW_ATTRIBUTE}]`);
      const targetName = row?.getAttribute(API_CONFIG_ROW_ATTRIBUTE) ?? null;
      if (!targetName || targetName === sourceName) {
        return;
      }
      const names = visibleNamesRef.current;
      const placement: ApiConfigDropPlacement =
        names.indexOf(sourceName) < names.indexOf(targetName)
          ? "after"
          : "before";
      setDragState((previous) =>
        previous &&
        previous.targetName === targetName &&
        previous.placement === placement
          ? previous
          : { sourceName, targetName, placement },
      );
    },
    [],
  );

  /**
   * 拖拽悬停在滚动容器上下边缘时逐帧滚动。
   * 越靠近边缘滚动越快，鼠标移出容器后自动停止。
   */
  const startAutoScroll = useCallback(
    (
      container: HTMLElement,
      sourceName: string,
      pointerX: number,
      pointerY: number,
    ): void => {
      const existing = autoScrollRef.current;
      if (existing) {
        existing.container = container;
        existing.sourceName = sourceName;
        existing.pointerX = pointerX;
        existing.pointerY = pointerY;
        return;
      }

      const state: ApiConfigAutoScrollState = {
        container,
        sourceName,
        pointerX,
        pointerY,
        frame: null,
      };
      autoScrollRef.current = state;

      const step = (): void => {
        const active = autoScrollRef.current;
        if (!active) {
          return;
        }
        const elementUnderPointer = document.elementFromPoint(
          active.pointerX,
          active.pointerY,
        );
        if (
          !elementUnderPointer ||
          !active.container.contains(elementUnderPointer)
        ) {
          stopAutoScroll();
          return;
        }

        const rect = active.container.getBoundingClientRect();
        const topEdge = rect.top + AUTO_SCROLL_EDGE;
        const bottomEdge = rect.bottom - AUTO_SCROLL_EDGE;
        let delta = 0;
        if (active.pointerY < topEdge) {
          const intensity = Math.min(
            1,
            (topEdge - active.pointerY) / AUTO_SCROLL_EDGE,
          );
          delta = -Math.max(1, Math.ceil(intensity * AUTO_SCROLL_MAX_STEP));
        } else if (active.pointerY > bottomEdge) {
          const intensity = Math.min(
            1,
            (active.pointerY - bottomEdge) / AUTO_SCROLL_EDGE,
          );
          delta = Math.max(1, Math.ceil(intensity * AUTO_SCROLL_MAX_STEP));
        }

        if (delta !== 0) {
          const before = active.container.scrollTop;
          active.container.scrollTop = before + delta;
          if (active.container.scrollTop !== before) {
            const currentElement = document.elementFromPoint(
              active.pointerX,
              active.pointerY,
            );
            if (currentElement) {
              syncDropTargetFromPointer(active.sourceName, currentElement);
            }
          }
        }

        active.frame = requestAnimationFrame(step);
      };

      state.frame = requestAnimationFrame(step);
    },
    [stopAutoScroll, syncDropTargetFromPointer],
  );

  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  const resolvePlacement = useCallback(
    (sourceName: string, targetName: string): ApiConfigDropPlacement =>
      visibleNames.indexOf(sourceName) < visibleNames.indexOf(targetName)
        ? "after"
        : "before",
    [visibleNames],
  );

  const submitMove = useCallback(
    (
      sourceName: string,
      targetName: string,
      placement: ApiConfigDropPlacement,
    ): void => {
      const next = moveApiConfigName(
        allNames,
        sourceName,
        targetName,
        placement,
      );
      if (next === allNames) {
        return;
      }
      onReorder([...next]);
    },
    [allNames, onReorder],
  );

  const moveByOffset = useCallback(
    (name: string, offset: -1 | 1): void => {
      const index = visibleNames.indexOf(name);
      const targetIndex = index + offset;
      if (index < 0 || targetIndex < 0 || targetIndex >= visibleNames.length) {
        return;
      }
      submitMove(
        name,
        visibleNames[targetIndex],
        offset < 0 ? "before" : "after",
      );
    },
    [submitMove, visibleNames],
  );

  const getDragHandleProps = useCallback(
    (name: string): ApiConfigDragHandleProps => ({
      draggable: true,
      onDragStart: (event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(API_CONFIG_DRAG_TYPE, name);
        setDragState({ sourceName: name, targetName: null, placement: null });
      },
      onDragEnd: () => {
        stopAutoScroll();
        setDragState(null);
      },
    }),
    [stopAutoScroll],
  );

  const getDropTargetProps = useCallback(
    (name: string): ApiConfigDropTargetProps => ({
      onDragOver: (event) => {
        if (!event.dataTransfer.types.includes(API_CONFIG_DRAG_TYPE)) {
          return;
        }
        const sourceName = dragState?.sourceName;
        if (!sourceName) {
          return;
        }
        const container = findScrollableAncestor(event.currentTarget);
        if (container) {
          startAutoScroll(container, sourceName, event.clientX, event.clientY);
        }
        if (sourceName === name) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const placement = resolvePlacement(sourceName, name);
        setDragState((previous) =>
          previous &&
          previous.targetName === name &&
          previous.placement === placement
            ? previous
            : { sourceName, targetName: name, placement },
        );
      },
      onDragLeave: (event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (nextTarget && event.currentTarget.contains(nextTarget)) {
          return;
        }
        setDragState((previous) =>
          previous && previous.targetName === name
            ? { ...previous, targetName: null, placement: null }
            : previous,
        );
      },
      onDrop: (event) => {
        const sourceName = dragState?.sourceName;
        stopAutoScroll();
        setDragState(null);
        if (!sourceName || sourceName === name) {
          return;
        }
        event.preventDefault();
        submitMove(sourceName, name, resolvePlacement(sourceName, name));
      },
    }),
    [dragState, resolvePlacement, startAutoScroll, stopAutoScroll, submitMove],
  );

  return {
    draggingName: dragState?.sourceName ?? null,
    dropTargetName: dragState?.targetName ?? null,
    dropPlacement: dragState?.placement ?? null,
    canMoveUp: (name) => visibleNames.indexOf(name) > 0,
    canMoveDown: (name) => {
      const index = visibleNames.indexOf(name);
      return index >= 0 && index < visibleNames.length - 1;
    },
    moveUp: (name) => moveByOffset(name, -1),
    moveDown: (name) => moveByOffset(name, 1),
    getDragHandleProps,
    getDropTargetProps,
  };
};
