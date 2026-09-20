import { useState } from "react";

import type { ChatConversationRecord } from "../../../../../preload";
import { isChatDrag, readChatDragData } from "../chatDrag";
import type { UseChatConversationResult } from "../../../mainContent/chatMessages/utils/conversationTypes";
import type {
  CrossProjectNotification,
  CrossProjectNotificationGroup,
} from "../useCrossProjectNotifications";

type UseChatsSectionInteractionsOptions = {
  isArchiveMode: boolean;
  setIsChatDragOver: (isDragOver: boolean) => void;
  refreshConversations: () => void;
  handleSelectConversation: UseChatConversationResult["handleSelectConversation"];
};

export function useChatsSectionInteractions({
  isArchiveMode,
  setIsChatDragOver,
  refreshConversations,
  handleSelectConversation,
}: UseChatsSectionInteractionsOptions) {
  // 置顶分组拖拽悬停：高亮提示拖入即置顶
  const [isPinnedDragOver, setIsPinnedDragOver] = useState(false);

  // 打开其他项目的通知会话：先激活其所属项目，再打开会话。
  // 激活成功后主进程广播 workspace-directory-list:changed，项目列表与
  // 对话列表会自动刷新到目标项目，随后 handleSelectConversation 加载
  // 会话历史；即使激活失败，会话记录已存在，直接打开也不受影响。
  const handleOpenCrossProjectNotification = async (
    group: CrossProjectNotificationGroup,
    notification: CrossProjectNotification,
  ): Promise<void> => {
    try {
      await window.snow.activateWorkspaceDirectory(group.directoryId);
    } catch {
      // 项目切换失败不阻塞会话打开
    }
    await handleSelectConversation(
      notification.conversation.conversationId,
      notification.conversation.summary || notification.conversation.title,
      {
        inputTokens: notification.conversation.inputTokens,
        outputTokens: notification.conversation.outputTokens,
        cacheCreationInputTokens:
          notification.conversation.cacheCreationInputTokens,
        cacheReadInputTokens: notification.conversation.cacheReadInputTokens,
      },
      group.directoryId,
    );
  };

  /** 会话拖拽悬停：允许放置并高亮提示（归档视图不可放置） */
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (isArchiveMode || !isChatDrag(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setIsChatDragOver(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsChatDragOver(false);
  };

  /** 拖入普通会话列表：取消拖拽会话的置顶 */
  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    setIsChatDragOver(false);
    if (isArchiveMode || !isChatDrag(event)) {
      return;
    }
    event.preventDefault();
    const payload = readChatDragData(event);
    // 非会话拖拽或来源已是普通会话时无需变更
    if (!payload || payload.status === "active") {
      return;
    }
    void window.snow
      .updateConversationStatus(payload.conversationId, "active")
      .then(() => refreshConversations())
      .catch(() => {
        // Silent fail
      });
  };

  /** 拖入置顶分组：将会话置顶（拦截冒泡，避免被外层"取消置顶"处理） */
  const handlePinnedDragOver = (
    event: React.DragEvent<HTMLDivElement>,
  ): void => {
    if (isArchiveMode || !isChatDrag(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setIsChatDragOver(false);
    setIsPinnedDragOver(true);
  };

  const handlePinnedDragLeave = (
    event: React.DragEvent<HTMLDivElement>,
  ): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsPinnedDragOver(false);
  };

  /** 拖入置顶分组：将拖拽的会话置顶 */
  const handlePinnedDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    setIsPinnedDragOver(false);
    if (isArchiveMode || !isChatDrag(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const payload = readChatDragData(event);
    if (!payload || payload.status === "pin") {
      return;
    }
    void window.snow
      .updateConversationStatus(payload.conversationId, "pin")
      .then(() => refreshConversations())
      .catch(() => {
        // Silent fail
      });
  };

  const handleSelectConversationFromList = (
    conversation: ChatConversationRecord,
  ): void => {
    void handleSelectConversation(
      conversation.conversationId,
      conversation.summary || conversation.title,
      {
        inputTokens: conversation.inputTokens,
        outputTokens: conversation.outputTokens,
        cacheCreationInputTokens: conversation.cacheCreationInputTokens,
        cacheReadInputTokens: conversation.cacheReadInputTokens,
      },
      conversation.directoryId,
    );
  };

  const handleSelectChildConversation = (
    conversationId: string,
    childDirectoryId: string,
  ): void => {
    void handleSelectConversation(
      conversationId,
      undefined,
      undefined,
      childDirectoryId,
    );
  };

  return {
    handleOpenCrossProjectNotification,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePinnedDragOver,
    handlePinnedDragLeave,
    handlePinnedDrop,
    isPinnedDragOver,
    handleSelectConversationFromList,
    handleSelectChildConversation,
  };
}
