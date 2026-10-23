import { createContext, useContext, type ReactNode } from "react";
import { useChatConversation } from "../hooks/useChatConversation";
import type {
  ChatConversationSessions,
  UseChatConversationResult,
} from "../utils/conversationTypes";

type ChatConversationContextValue = UseChatConversationResult;

const ChatConversationContext = createContext<
  ChatConversationContextValue | undefined
>(undefined);

/**
 * 会话内存态表单独一个 context：它每个流式帧都会更换引用（会话消息在变），
 * 消费者只有侧边栏会话列表、跨项目通知、远控桥与插件桥这几处。若把它放进
 * 主 context 值，聊天区整棵树等全部消费者都会随后台会话的每个流式帧重渲染。
 */
const ChatConversationSessionsContext = createContext<
  ChatConversationSessions | undefined
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
  const { conversation, sessions } = useChatConversation(
    directoryId,
    directoryPath,
    isDetachedWindow,
  );

  return (
    <ChatConversationSessionsContext.Provider value={sessions}>
      <ChatConversationContext.Provider value={conversation}>
        {children}
      </ChatConversationContext.Provider>
    </ChatConversationSessionsContext.Provider>
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

export const useChatConversationSessions = (): ChatConversationSessions => {
  const sessions = useContext(ChatConversationSessionsContext);

  if (!sessions) {
    throw new Error(
      "useChatConversationSessions must be used within a ChatConversationProvider",
    );
  }

  return sessions;
};
