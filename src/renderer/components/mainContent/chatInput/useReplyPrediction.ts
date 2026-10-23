import { useCallback, useEffect, useRef, useState } from "react";
import { useReplyPredictionPreference } from "../../../hooks/useReplyPredictionPreference";
import type { ChatConversationMessage } from "../chatMessages/utils/conversationTypes";

/** 回合结束后等待落库再请求，避免读到不完整历史。 */
const PREDICTION_DELAY_MS = 800;

type UseReplyPredictionOptions = {
  conversationId: string | null;
  isStreaming: boolean;
  /** 子代理会话等不支持预测的场景。 */
  disabled: boolean;
  value: string;
  apiProfile?: string;
  messages: ChatConversationMessage[];
};

/** 回合结束后预测用户下一句；用户输入即清除，Tab 由调用方采用。 */
export const useReplyPrediction = ({
  conversationId,
  isStreaming,
  disabled,
  value,
  apiProfile,
  messages,
}: UseReplyPredictionOptions): {
  prediction: string | null;
  consumePrediction: () => string | null;
} => {
  const { replyPredictionEnabled } = useReplyPredictionPreference();
  const [prediction, setPrediction] = useState<string | null>(null);
  const [turnCounter, setTurnCounter] = useState(0);
  const isEmpty = value.trim().length === 0;
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;
  const lastMessageRef = useRef<ChatConversationMessage | undefined>(undefined);
  lastMessageRef.current = messages[messages.length - 1];
  const wasStreamingRef = useRef(isStreaming);

  // 仅在本次挂载内观察到回合结束时触发，打开历史会话不预测。
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      setTurnCounter((count) => count + 1);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const active =
    replyPredictionEnabled && !disabled && !isStreaming && !!conversationId;

  useEffect(() => {
    if (!active) {
      setPrediction(null);
    }
  }, [active]);

  useEffect(() => {
    if (!isEmpty) {
      setPrediction(null);
    }
  }, [isEmpty]);

  useEffect(() => {
    if (!active || turnCounter === 0 || !conversationId) {
      return;
    }
    let requestId: string | null = null;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const last = lastMessageRef.current;
      if (
        !isEmptyRef.current ||
        !last ||
        last.role !== "assistant" ||
        last.status === "error" ||
        last.status === "incomplete"
      ) {
        return;
      }
      const id = `reply-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      requestId = id;
      window.snow
        .predictReply({ requestId: id, conversationId, apiProfile })
        .then((result) => {
          requestId = null;
          const text = result.content.trim();
          if (!cancelled && text && isEmptyRef.current) {
            setPrediction(text);
          }
        })
        .catch(() => {
          requestId = null;
        });
    }, PREDICTION_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (requestId) {
        void window.snow.abortReplyPrediction(requestId).catch(() => {});
      }
    };
  }, [active, turnCounter, conversationId, apiProfile]);

  const consumePrediction = useCallback((): string | null => {
    const text = prediction;
    setPrediction(null);
    return text;
  }, [prediction]);

  return { prediction: isEmpty ? prediction : null, consumePrediction };
};
