import { useCallback, useEffect, useRef, useState } from "react";
import { formatMessageTime } from "../utils/conversationHelpers";

export type ChatConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
};

type UseMockChatConversationResult = {
  messages: ChatConversationMessage[];
  handleSendMessage: (message: string) => void;
};

const createMessageId = (role: ChatConversationMessage["role"]): string =>
  `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const createMockAiResponse = (message: string): string =>
  `我已收到你的消息：“${message}”。这里先保留模拟 AI 响应，后续可以替换为真实请求流程。`;

export const useMockChatConversation = (): UseMockChatConversationResult => {
  const [messages, setMessages] = useState<ChatConversationMessage[]>([]);
  const responseTimersRef = useRef<number[]>([]);

  const handleSendMessage = useCallback((message: string) => {
    const userMessage: ChatConversationMessage = {
      id: createMessageId("user"),
      role: "user",
      content: message,
      timestamp: formatMessageTime(),
    };

    setMessages((currentMessages) => [...currentMessages, userMessage]);

    const responseTimer = window.setTimeout(() => {
      const assistantMessage: ChatConversationMessage = {
        id: createMessageId("assistant"),
        role: "assistant",
        content: createMockAiResponse(message),
        timestamp: formatMessageTime(),
      };

      setMessages((currentMessages) => [...currentMessages, assistantMessage]);
    }, 450);

    responseTimersRef.current.push(responseTimer);
  }, []);

  useEffect(() => {
    const responseTimers = responseTimersRef.current;

    return () => {
      responseTimers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  return { messages, handleSendMessage };
};
