import { useEffect } from "react";

import type { WorkspaceDirectoryRecord } from "../../../preload";
import { ChatContent } from "../mainContent/ChatContent";
import { useChatConversationContext } from "../mainContent/chatMessages";
import { isPendingSessionKey } from "../mainContent/chatMessages/utils/conversationTypes";
import { registerConversationPane } from "./detachedPanelTab";

type ConversationTabPaneProps = {
  conversationId: string;
  isActive: boolean;
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

/** 聊天视图本体：挂载期间登记为会话面板（元素标签由其中的输入框接收）。 */
const ConversationChatBody = ({
  activeDirectory,
}: {
  activeDirectory?: WorkspaceDirectoryRecord | null;
}): React.JSX.Element => {
  useEffect(() => registerConversationPane(), []);
  return (
    <div className="detached-conversation-body">
      <ChatContent activeDirectory={activeDirectory} />
    </div>
  );
};

/**
 * 独立面板窗口中的会话 tab 内容。仅当该 tab 为活动 tab、且会话运行时正在展示
 * 该 tab 对应的内容时才挂载聊天视图；其它会话 tab 不挂载，避免多个聊天视图同时
 * 展示同一个活动会话。
 * - 普通会话 tab：运行时已切换到该会话，或当前为新会话草稿（pending）；
 * - 新会话草稿 tab（conversationId 为空）：运行时尚未有活动会话（新会话视图）或为草稿。
 */
export const ConversationTabPane = ({
  conversationId,
  isActive,
  activeDirectory,
}: ConversationTabPaneProps): React.JSX.Element | null => {
  const { activeConversationId } = useChatConversationContext();
  if (!isActive) {
    return null;
  }
  const isShowingThisConversation = activeConversationId === conversationId;
  const isShowingPendingChat =
    activeConversationId !== undefined &&
    isPendingSessionKey(activeConversationId);
  const isShowingNewChatView =
    conversationId === "" && activeConversationId === undefined;
  if (
    !isShowingThisConversation &&
    !isShowingPendingChat &&
    !isShowingNewChatView
  ) {
    return null;
  }
  return <ConversationChatBody activeDirectory={activeDirectory} />;
};
