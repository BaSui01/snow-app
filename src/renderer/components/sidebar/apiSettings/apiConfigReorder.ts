import { useCallback, useState } from "react";
import type { DragEvent } from "react";
import type { ApiConfigRecord } from "../../../../preload";

/** 拖拽落点：放到目标项之前 / 之后。 */
export type ApiConfigDropPlacement = "before" | "after";

/** 拖拽数据里写入的自定义类型，避免与文件、会话等其它拖拽源互相干扰。 */
const API_CONFIG_DRAG_TYPE = "application/x-snow-api-config";

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
      onDragEnd: () => setDragState(null),
    }),
    [],
  );

  const getDropTargetProps = useCallback(
    (name: string): ApiConfigDropTargetProps => ({
      onDragOver: (event) => {
        if (!event.dataTransfer.types.includes(API_CONFIG_DRAG_TYPE)) {
          return;
        }
        const sourceName = dragState?.sourceName;
        if (!sourceName || sourceName === name) {
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
        setDragState(null);
        if (!sourceName || sourceName === name) {
          return;
        }
        event.preventDefault();
        submitMove(sourceName, name, resolvePlacement(sourceName, name));
      },
    }),
    [dragState, resolvePlacement, submitMove],
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
