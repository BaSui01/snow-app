import { useEffect, useState } from "react";

import type { ChatConversationRecord } from "../../../../../preload";

type UpsertedConversationLike = {
  record: ChatConversationRecord;
};

type UsePinnedConversationsOptions = {
  directoryId: string;
  conversationListVersion: number;
  upsertedConversation: UpsertedConversationLike | null;
};

export function usePinnedConversations({
  directoryId,
  conversationListVersion,
  upsertedConversation,
}: UsePinnedConversationsOptions) {
  const [conversations, setConversations] = useState<ChatConversationRecord[]>(
    []
  );

  useEffect(() => {
    if (!directoryId) {
      setConversations([]);
      return;
    }

    let cancelled = false;

    const loadPinnedConversations = async (): Promise<void> => {
      try {
        const result = await window.snow.listPinnedConversations(directoryId);

        if (!cancelled) {
          setConversations(result);
        }
      } catch {
        if (!cancelled) {
          setConversations([]);
        }
      }
    };

    void loadPinnedConversations();

    return () => {
      cancelled = true;
    };
  }, [directoryId, conversationListVersion]);

  useEffect(() => {
    if (!upsertedConversation) {
      return;
    }

    const { record: conv } = upsertedConversation;
    if (conv.directoryId !== directoryId) {
      return;
    }

    setConversations((prev) => {
      const existing = prev.find(
        (item) => item.conversationId === conv.conversationId
      );

      // 取消置顶的会话从置顶列表移除（主列表由 conversationListVersion 重拉接管）
      if (existing) {
        if (conv.status !== "pin") {
          return prev.filter(
            (item) => item.conversationId !== conv.conversationId
          );
        }
        if (JSON.stringify(existing) === JSON.stringify(conv)) {
          return prev;
        }
        return prev.map((item) =>
          item.conversationId === conv.conversationId ? conv : item
        );
      }

      if (conv.status === "pin") {
        return [conv, ...prev];
      }

      return prev;
    });
  }, [upsertedConversation, directoryId]);
  return {
    pinnedConversations: conversations,
  };
}
