import { createContext, useContext, type ReactNode } from "react";
import { useChatConversation } from "../hooks/useChatConversation";

type ChatConversationContextValue = ReturnType<typeof useChatConversation>;

const ChatConversationContext = createContext<
  ChatConversationContextValue | undefined
>(undefined);

export const ChatConversationProvider = ({
  children,
  directoryId,
  directoryPath,
  isDetachedWindow = false,
}: {
  children: ReactNode;
  directoryId?: string;
  directoryPath?: string;
  /** 独立面板窗口内的会话运行时：不拦截归属会话的点击（归属由主窗口处理）。 */
  isDetachedWindow?: boolean;
}): React.JSX.Element => {
  const conversation = useChatConversation(
    directoryId,
    directoryPath,
    isDetachedWindow,
  );

  return (
    <ChatConversationContext.Provider value={conversation}>
      {children}
    </ChatConversationContext.Provider>
  );
};

export const useChatConversationContext = (): ChatConversationContextValue => {
  const context = useContext(ChatConversationContext);

  if (!context) {
    throw new Error(
      "useChatConversationContext must be used within a ChatConversationProvider",
    );
  }

  return context;
};
