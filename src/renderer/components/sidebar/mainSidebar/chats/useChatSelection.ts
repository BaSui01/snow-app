import { useState } from "react";

import type { ChatConversationRecord } from "../../../../../preload";
import { isPendingSessionKey } from "../../../mainContent/chatMessages/utils/conversationTypes";
import type { TimeGroup } from "../chatTimeGroup";

type UseChatSelectionOptions = {
  conversations: ChatConversationRecord[];
  runningConversationIds: Set<string>;
  surfacedConversationIds: Set<string>;
};

export function useChatSelection({
  conversations,
  runningConversationIds,
  surfacedConversationIds,
}: UseChatSelectionOptions) {
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const enterMultiSelect = (): void => {
    setSelectedIds(new Set());
    setIsMultiSelectMode(true);
  };

  const exitMultiSelect = (): void => {
    setIsMultiSelectMode(false);
    setSelectedIds(new Set());
  };

  const resetMultiSelect = (): void => {
    setSelectedIds(new Set());
    setIsMultiSelectMode(false);
  };

  const handleToggleSelect = (conversationId: string): void => {
    // 运行中的会话不允许进入多选集合
    if (runningConversationIds.has(conversationId)) {
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
  };

  /** 可参与多选的会话：排除 PENDING 占位会话与运行中会话（流式/待确认/含待确认子代理） */
  const isMultiSelectable = (conv: ChatConversationRecord): boolean =>
    !isPendingSessionKey(conv.conversationId) &&
    !runningConversationIds.has(conv.conversationId) &&
    !surfacedConversationIds.has(conv.conversationId);
  // 可多选会话总数：用于顶部全选按钮的文案切换
  const multiSelectableCount = conversations.filter(isMultiSelectable).length;

  const handleSelectAll = (): void => {
    const allIds = conversations
      .filter(isMultiSelectable)
      .map((conv) => conv.conversationId);
    setSelectedIds(new Set(allIds));
  };

  const handleDeselectAll = (): void => {
    setSelectedIds(new Set());
  };

  /**
   * 分组粒度的全选/取消全选：目标分组内全部已选时取消该组，
   * 否则选中该组全部（与顶部全局全选互不影响）。
   */
  const handleToggleGroupSelect = (group: TimeGroup): void => {
    const groupIds = group.conversations
      .filter(isMultiSelectable)
      .map((conv) => conv.conversationId);
    if (groupIds.length === 0) {
      return;
    }
    const allSelected = groupIds.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of groupIds) {
        if (allSelected) {
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
    isMultiSelectable,
    multiSelectableCount,
    handleSelectAll,
    handleDeselectAll,
    handleToggleGroupSelect,
  };
}