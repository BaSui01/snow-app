import { useCallback, useEffect, useRef, useState } from "react";
import { useReplyPredictionPreference } from "../../../hooks/useReplyPredictionPreference";
import type { ChatConversationMessage } from "../chatMessages/utils/conversationTypes";

/** 回合结束后等待落库再请求，避免读到不完整历史。 */
const PREDICTION_DELAY_MS = 800;
/** 会话级预测池上限：只保留最近若干会话，长期运行也不会无限增长。 */
const PREDICTION_POOL_LIMIT = 64;

/**
 * 会话级预测缓存（conversationId -> 预测文本）。ChatInput 随会话切换（key
 * 变化）而重建，预测与输入草稿一样按会话留存：切走时不丢，切回且输入框仍为
 * 空时原样恢复；用户开始输入、采用预测或新一轮对话开始即清除该会话的预测。
 */
const predictionPool = new Map<string, string>();

const readPrediction = (conversationId: string | null): string | null =>
  conversationId ? (predictionPool.get(conversationId) ?? null) : null;

const writePrediction = (conversationId: string, text: string): void => {
  predictionPool.delete(conversationId);
  predictionPool.set(conversationId, text);
  while (predictionPool.size > PREDICTION_POOL_LIMIT) {
    const oldest = predictionPool.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    predictionPool.delete(oldest);
  }
};

const dropPrediction = (conversationId: string | null): void => {
  if (conversationId) {
    predictionPool.delete(conversationId);
  }
};

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
  // 初始为空：恢复放在 effect 里，与输入草稿的恢复同批提交，避免有草稿的
  // 会话切回时先闪一帧预测再被草稿盖住。
  const [prediction, setPrediction] = useState<string | null>(null);
  const [turnCounter, setTurnCounter] = useState(0);
  const isEmpty = value.trim().length === 0;
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
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

  /** 丢弃当前会话的预测：内存态与池同时清除。 */
  const clearPrediction = useCallback((): void => {
    setPrediction(null);
    dropPrediction(conversationIdRef.current);
  }, []);

  // 挂载或会话标识变化而实例未重建时（pending 槽位迁移为真实 ID），
  // 恢复目标会话留存的预测。
  useEffect(() => {
    setPrediction(readPrediction(conversationId));
  }, [conversationId]);

  useEffect(() => {
    if (!active) {
      clearPrediction();
    }
  }, [active, clearPrediction]);

  useEffect(() => {
    if (!isEmpty) {
      clearPrediction();
    }
  }, [isEmpty, clearPrediction]);

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
            // 请求期间未切走会话（cancelled 为假），结果归属当前会话。
            writePrediction(conversationId, text);
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
    clearPrediction();
    return text;
  }, [prediction, clearPrediction]);

  return { prediction: isEmpty ? prediction : null, consumePrediction };
};
