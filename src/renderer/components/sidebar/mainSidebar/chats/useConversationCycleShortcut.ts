import { useEffect, useRef } from "react";

import { shortcutEvents } from "../../../shortcutEvents";

type UseConversationCycleShortcutOptions = {
  /** 是否启用（树模式只在当前激活项目上启用，避免多个项目节点重复响应） */
  enabled?: boolean;
  /** 参与轮换的会话 id，顺序即列表显示顺序（置顶在前） */
  orderedConversationIds: string[];
  activeConversationId?: string;
  onSelect: (conversationId: string) => void;
};

/** Option/Alt+左右方向键：切换上一个/下一个会话 */
export function useConversationCycleShortcut({
  enabled = true,
  orderedConversationIds,
  activeConversationId,
  onSelect,
}: UseConversationCycleShortcutOptions): void {
  // 用 ref 持有最新状态：列表频繁重渲染时不重新订阅
  const stateRef = useRef({
    orderedConversationIds,
    activeConversationId,
    onSelect,
  });
  useEffect(() => {
    stateRef.current = {
      orderedConversationIds,
      activeConversationId,
      onSelect,
    };
  }, [orderedConversationIds, activeConversationId, onSelect]);

  const isActive = enabled && orderedConversationIds.length > 0;
  useEffect(() => {
    if (!isActive) {
      return;
    }
    const cycle = (offset: number): void => {
      const {
        orderedConversationIds: ids,
        activeConversationId: currentId,
        onSelect: select,
      } = stateRef.current;
      if (ids.length === 0) {
        return;
      }
      const currentIndex = ids.indexOf(currentId ?? "");
      if (currentIndex === -1) {
        select(ids[0]);
        return;
      }
      select(ids[(currentIndex + offset + ids.length) % ids.length]);
    };
    const unsubPrev = shortcutEvents.on("prev-conversation", () => cycle(-1));
    const unsubNext = shortcutEvents.on("next-conversation", () => cycle(1));
    return () => {
      unsubPrev();
      unsubNext();
    };
  }, [isActive]);
}
