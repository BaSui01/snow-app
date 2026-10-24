import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChatConversationRecord } from "../../../../../preload";
import { isPendingSessionKey } from "../../../mainContent/chatMessages/utils/conversationTypes";
import type { TimeGroup } from "../chatTimeGroup";

type SelectionModifiers = {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
};

type UseChatSelectionOptions = {
  directoryId: string;
  conversations: ChatConversationRecord[];
  getOrderedConversationIds: () => readonly string[];
  runningConversationIds: Set<string>;
  surfacedConversationIds: Set<string>;
};

export function useChatSelection({
  directoryId,
  conversations,
  getOrderedConversationIds,
  runningConversationIds,
  surfacedConversationIds,
}: UseChatSelectionOptions) {
  const [selectionDirectoryId, setSelectionDirectoryId] = useState(directoryId);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [storedSelectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const anchorRef = useRef<string | null>(null);
  const [blockedRunIds, setBlockedRunIds] = useState<Set<string>>(
    () => new Set(),
  );
  const blockedRunIdsRef = useRef(blockedRunIds);
  const handleSelectionBlockedChange = useCallback(
    (conversationId: string, blocked: boolean): void => {
      const previous = blockedRunIdsRef.current;
      if (previous.has(conversationId) === blocked) {
        return;
      }
      const next = new Set(previous);
      if (blocked) {
        next.add(conversationId);
      } else {
        next.delete(conversationId);
      }
      // layout effect 上报后立即保护事件处理；state 负责刷新资格和计数。
      blockedRunIdsRef.current = next;
      setBlockedRunIds(next);
      if (blocked) {
        if (anchorRef.current === conversationId) {
          anchorRef.current = null;
        }
        setSelectedIds((selected) => {
          if (!selected.has(conversationId)) {
            return selected;
          }
          const validIds = new Set(selected);
          validIds.delete(conversationId);
          return validIds;
        });
      }
    },
    [],
  );

  // 项目切换时在本次渲染中重置，避免批量操作收到上一项目的选择。
  if (selectionDirectoryId !== directoryId) {
    setSelectionDirectoryId(directoryId);
    setIsMultiSelectMode(false);
    setSelectedIds(new Set());
    anchorRef.current = null;
  }

  /** 可参与多选的普通会话：排除置顶、PENDING 与运行/待确认会话。 */
  const isMultiSelectable = useCallback(
    (conv: ChatConversationRecord): boolean =>
      conv.directoryId === directoryId &&
      conv.status !== "pin" &&
      !isPendingSessionKey(conv.conversationId) &&
      !runningConversationIds.has(conv.conversationId) &&
      !surfacedConversationIds.has(conv.conversationId) &&
      !blockedRunIdsRef.current.has(conv.conversationId),
    [directoryId, runningConversationIds, surfacedConversationIds],
  );
  const selectableIds = useMemo(
    () =>
      new Set(
        conversations
          .filter(isMultiSelectable)
          .map((conv) => conv.conversationId),
      ),
    // ref 同步守卫事件；state 变化使渲染资格、全选计数与失效选择同步刷新。
    [conversations, isMultiSelectable, blockedRunIds],
  );
  // 即使清理 effect 尚未提交，也不向批量操作暴露失效 ID。
  const selectedIds = useMemo(() => {
    const validIds = new Set(
      [...storedSelectedIds].filter((id) => selectableIds.has(id)),
    );
    return validIds.size === storedSelectedIds.size
      ? storedSelectedIds
      : validIds;
  }, [storedSelectedIds, selectableIds]);

  useEffect(() => {
    setSelectedIds((previous) => {
      const next = new Set([...previous].filter((id) => selectableIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
    if (anchorRef.current !== null && !selectableIds.has(anchorRef.current)) {
      anchorRef.current = null;
    }
  }, [selectableIds]);

  // 仅保存 getter，不在渲染或 effect 调用：调用方可能闭包引用稍后声明的分组。
  const latestRef = useRef({
    getOrderedConversationIds,
    selectableIds,
    isMultiSelectMode,
  });
  latestRef.current = {
    getOrderedConversationIds,
    selectableIds,
    isMultiSelectMode,
  };

  const enterMultiSelect = useCallback((): void => {
    anchorRef.current = null;
    setSelectedIds(new Set());
    setIsMultiSelectMode(true);
  }, []);

  const exitMultiSelect = useCallback((): void => {
    anchorRef.current = null;
    setIsMultiSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const resetMultiSelect = exitMultiSelect;

  const handleToggleSelect = useCallback(
    (conversationId: string, modifiers?: SelectionModifiers): boolean => {
      const latest = latestRef.current;
      // 行的 layout effect 可能先于父列表重渲染，事件必须读取同步阻塞集。
      const current = {
        ...latest,
        selectableIds: new Set(
          [...latest.selectableIds].filter(
            (id) => !blockedRunIdsRef.current.has(id),
          ),
        ),
      };
      const orderedIds = current.getOrderedConversationIds();
      const additive = modifiers?.ctrlKey || modifiers?.metaKey;
      const shift = modifiers?.shiftKey;
      const selectable =
        current.selectableIds.has(conversationId) &&
        orderedIds.includes(conversationId);
      const previousAnchor = anchorRef.current;
      const anchor =
        previousAnchor !== null &&
        current.selectableIds.has(previousAnchor) &&
        orderedIds.includes(previousAnchor)
          ? previousAnchor
          : null;
      anchorRef.current = anchor;

      if (!shift && !additive && !current.isMultiSelectMode) {
        anchorRef.current = selectable ? conversationId : null;
        return false;
      }
      // 修饰键点击不可选行也消费事件，但不进入空多选或导航。
      if (!selectable) {
        if (!shift && !additive) {
          anchorRef.current = null;
        }
        return true;
      }

      setIsMultiSelectMode(true);
      if (shift) {
        const targetIndex = orderedIds.indexOf(conversationId);
        const anchorIndex =
          anchor === null ? targetIndex : orderedIds.indexOf(anchor);
        const range = orderedIds
          .slice(
            Math.min(anchorIndex, targetIndex),
            Math.max(anchorIndex, targetIndex) + 1,
          )
          .filter((id) => current.selectableIds.has(id));
        if (anchor === null) {
          anchorRef.current = conversationId;
        }
        setSelectedIds(
          (previous) =>
            new Set([
              ...(additive
                ? [...previous].filter((id) => current.selectableIds.has(id))
                : []),
              ...range,
            ]),
        );
      } else {
        anchorRef.current = conversationId;
        setSelectedIds((previous) => {
          const next = new Set(
            [...previous].filter((id) => current.selectableIds.has(id)),
          );
          if (additive && !current.isMultiSelectMode && anchor !== null) {
            next.add(anchor);
          }
          if (next.has(conversationId)) {
            next.delete(conversationId);
          } else {
            next.add(conversationId);
          }
          return next;
        });
      }
      return true;
    },
    [],
  );

  const multiSelectableCount = selectableIds.size;

  const handleSelectAll = (): void => {
    setSelectedIds(
      new Set(
        [...selectableIds].filter((id) => !blockedRunIdsRef.current.has(id)),
      ),
    );
  };

  const handleDeselectAll = (): void => {
    anchorRef.current = null;
    setSelectedIds(new Set());
  };

  /** 分组内全部已选时取消该组，否则追加该组全部可选会话。 */
  const handleToggleGroupSelect = (group: TimeGroup): void => {
    const groupIds = group.conversations
      .filter(isMultiSelectable)
      .map((conv) => conv.conversationId);
    if (groupIds.length === 0) {
      return;
    }
    const allSelected = groupIds.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(
        [...prev].filter(
          (id) => selectableIds.has(id) && !blockedRunIdsRef.current.has(id),
        ),
      );
      for (const id of groupIds) {
        if (allSelected || blockedRunIdsRef.current.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  };

  return {
    isMultiSelectMode,
    selectedIds,
    setSelectedIds,
    enterMultiSelect,
    exitMultiSelect,
    resetMultiSelect,
    handleToggleSelect,
    handleSelectionBlockedChange,
    isMultiSelectable,
    multiSelectableCount,
    handleSelectAll,
    handleDeselectAll,
    handleToggleGroupSelect,
  };
}
