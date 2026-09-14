import { useCallback, useEffect, useRef } from "react";
import type {
  ConversationContextValue,
  UserQuestionDraft,
  UserQuestionRequest,
} from "../utils/conversationTypes";

/**
 * 用户问题交互逻辑：注册 handler、回答/取消问题、拒绝待处理问题。
 * askUserQuestion 以 ToolCallInfo.interactionId 贯通 renderer/preload/main/Rust。
 *
 * 结算收口约定：所有"用户未作答即被迫结束"的路径（会话中断、handler 销毁、
 * 工具异常结束）必须统一走 interruptPendingUserQuestions —— 它在 reject 之前
 * 先把消息里的 userQuestion 标记为 cancelled + interrupted 并写诊断日志。
 * 缺了这一步，卡片会永远停在"等待回答"（错误结果无法被终态解析识别），而
 * agent loop 已把该提问当作失败结果继续执行（即"提问卡片泄漏"）。
 */
export const useUserQuestion = (ctx: ConversationContextValue) => {
  const {
    directoryId,
    notifyUserInteractionRequired,
    pendingUserQuestionRef,
    sessionsRefData,
    setPendingUserQuestionConversationIds,
    updateSessionMessages,
    userQuestionTargetRef,
  } = ctx;

  // directoryId 只用于通知的兜底目录。用 ref 读取最新值，避免目录切换时
  // 重跑下面的注册 effect（cleanup 会结算所有等待中的问题并清空
  // pendingUserQuestionRef / userQuestionTargetRef，导致 Rust 端工具调用
  // 报错、AI 重新提问——即切换项目后提问卡片"重新渲染一次"的现象）。
  const directoryIdRef = useRef(directoryId);
  directoryIdRef.current = directoryId;

  // 注册 effect 内的调用一律经 ref 取最新实现：effect 依赖只保留真正稳定的
  // 引用（ref 对象 / setState setter），任何无关依赖变化（例如语言切换重建
  // t → notifyUserInteractionRequired）都不再重跑 effect，自然也不会把等待中
  // 的提问"连坐"结算。
  const notifyUserInteractionRequiredRef = useRef(
    notifyUserInteractionRequired
  );
  notifyUserInteractionRequiredRef.current = notifyUserInteractionRequired;
  const updateSessionMessagesRef = useRef(updateSessionMessages);
  updateSessionMessagesRef.current = updateSessionMessages;

  // 提问卡片未提交交互草稿（按 questionId）。与消息状态解耦：卡片因会话
  // 切换（.chat-area 按 activeConversationId 作 key 而重挂载）时，本地
  // useState 会丢失，用草稿恢复用户已勾选/已输入的内容。
  const userQuestionDraftsRef = useRef(new Map<string, UserQuestionDraft>());

  const reconcilePendingUserQuestionConversationIds = useCallback((): void => {
    const conversationIds = new Set<string>();
    for (const pending of pendingUserQuestionRef.current.values()) {
      conversationIds.add(pending.sessionKey);
    }
    setPendingUserQuestionConversationIds(conversationIds);
  }, [pendingUserQuestionRef, setPendingUserQuestionConversationIds]);

  /**
   * 用户未作答即被迫结束的统一收口：先把消息里的 userQuestion 标记为
   * cancelled + interrupted（卡片据此显示"已中断"终态并停止交互），再清理
   * 运行时状态、写诊断日志、reject 挂起的 promise。reason 会进入日志与
   * reject error（被 Rust 包装为 "User question failed: {reason}" 回传模型）。
   */
  const interruptPendingUserQuestions = useCallback(
    (reason: string, sessionKey?: string): void => {
      const questionIds: string[] = [];
      for (const [questionId, pending] of pendingUserQuestionRef.current) {
        if (sessionKey && pending.sessionKey !== sessionKey) {
          continue;
        }
        questionIds.push(questionId);
      }

      for (const questionId of questionIds) {
        const pending = pendingUserQuestionRef.current.get(questionId);
        if (!pending) {
          continue;
        }

        const target = userQuestionTargetRef.current.get(pending.interactionId);
        if (target) {
          updateSessionMessagesRef.current(
            target.sessionKey,
            (currentMessages) =>
              currentMessages.map((message) => {
                if (message.id !== target.assistantMessageId) {
                  return message;
                }

                return {
                  ...message,
                  toolCalls: message.toolCalls?.map((toolCall) =>
                    toolCall.interactionId === pending.interactionId &&
                    toolCall.userQuestion?.questionId === questionId
                      ? {
                          ...toolCall,
                          userQuestion: {
                            ...toolCall.userQuestion,
                            status: "cancelled" as const,
                            interrupted: true,
                            selectedOptions: [],
                            customAnswers: [],
                          },
                        }
                      : toolCall
                  ),
                };
              })
          );
        }

        pendingUserQuestionRef.current.delete(questionId);
        userQuestionTargetRef.current.delete(pending.interactionId);
        userQuestionDraftsRef.current.delete(questionId);

        // 诊断日志：记录"谁结算了这个提问"。此前这些路径静默 reject，复现时
        // 只能在模型侧看到 "User question failed: ..."，无法定位触发来源。
        void window.snow.writeLog("WARN", {
          module: "chat/user-question",
          func: "interruptPendingUserQuestions",
          message: "User question settled without an answer",
          context: JSON.stringify({
            questionId,
            interactionId: pending.interactionId,
            sessionKey: pending.sessionKey,
            reason,
          }),
        });

        pending.reject(new Error(reason));
      }

      reconcilePendingUserQuestionConversationIds();
    },
    [
      pendingUserQuestionRef,
      reconcilePendingUserQuestionConversationIds,
      userQuestionTargetRef,
    ]
  );

  // 注册全局 UserQuestion handler，将问题挂到对应工具卡片
  useEffect(() => {
    const unregister = window.snow.registerUserQuestionHandler(
      (request: UserQuestionRequest): Promise<string> => {
        const target = userQuestionTargetRef.current.get(request.interactionId);
        if (!target) {
          // 请求不属于任何在途工具调用（interactionId 不匹配或已被结算）。
          // 写日志便于定位"提问在无人等待时到达"的时序问题。
          void window.snow.writeLog("WARN", {
            module: "chat/user-question",
            func: "registerUserQuestionHandler",
            message: "No active tool call matches this user question",
            context: JSON.stringify({
              questionId: request.questionId,
              interactionId: request.interactionId,
            }),
          });
          return Promise.reject(
            new Error("No active tool call matches this user question")
          );
        }

        updateSessionMessagesRef.current(target.sessionKey, (currentMessages) =>
          currentMessages.map((message) => {
            if (message.id !== target.assistantMessageId) {
              return message;
            }

            return {
              ...message,
              toolCalls: message.toolCalls?.map((toolCall) =>
                toolCall.interactionId === request.interactionId
                  ? {
                      ...toolCall,
                      userQuestion: {
                        questionId: request.questionId,
                        question: request.question,
                        options: request.options,
                        status: "waiting" as const,
                        selectedOptions: [],
                        customAnswers: [],
                      },
                    }
                  : toolCall
              ),
            };
          })
        );

        // 通知系统：用户交互工具需要用户回答时触发系统通知
        notifyUserInteractionRequiredRef.current({
          conversationId: target.sessionKey,
          directoryId:
            sessionsRefData.current.get(target.sessionKey)?.directoryId ??
            directoryIdRef.current,
          reason: request.question,
        });

        return new Promise<string>((resolve, reject) => {
          pendingUserQuestionRef.current.set(request.questionId, {
            sessionKey: target.sessionKey,
            interactionId: request.interactionId,
            resolve,
            reject,
          });
          reconcilePendingUserQuestionConversationIds();
        });
      }
    );

    return () => {
      unregister();
      // 处理器销毁（Provider 卸载）：等待中的提问被迫结束，走统一收口 ——
      // 先标记消息终态再 reject，卡片不会停留在"等待回答"。
      interruptPendingUserQuestions("User question handler was disposed");
      userQuestionTargetRef.current.clear();
    };
  }, [
    // 依赖只保留稳定引用：不引入 directoryId / notifyUserInteractionRequired /
    // updateSessionMessages（它们变化时重跑 effect 会把等待中的提问"连坐"结算）。
    interruptPendingUserQuestions,
    pendingUserQuestionRef,
    reconcilePendingUserQuestionConversationIds,
    sessionsRefData,
    userQuestionTargetRef,
  ]);

  const settleUserQuestion = useCallback(
    (
      questionId: string,
      cancelled: boolean,
      selectedOptions: string[],
      customAnswers: string[]
    ): void => {
      const pending = pendingUserQuestionRef.current.get(questionId);
      if (!pending) {
        return;
      }

      const normalizeAnswers = (values: string[]): string[] =>
        Array.from(
          new Set(values.map((value) => value.trim()).filter(Boolean))
        );
      const normalizedSelected = cancelled
        ? []
        : normalizeAnswers(selectedOptions);
      const normalizedCustom = cancelled ? [] : normalizeAnswers(customAnswers);
      const answers = normalizeAnswers([
        ...normalizedSelected,
        ...normalizedCustom,
      ]);
      if (!cancelled && answers.length === 0) {
        return;
      }

      const target = userQuestionTargetRef.current.get(pending.interactionId);
      if (target) {
        updateSessionMessages(target.sessionKey, (currentMessages) =>
          currentMessages.map((message) => {
            if (message.id !== target.assistantMessageId) {
              return message;
            }

            return {
              ...message,
              toolCalls: message.toolCalls?.map((toolCall) =>
                toolCall.interactionId === pending.interactionId &&
                toolCall.userQuestion?.questionId === questionId
                  ? {
                      ...toolCall,
                      userQuestion: {
                        ...toolCall.userQuestion,
                        status: cancelled
                          ? ("cancelled" as const)
                          : ("answered" as const),
                        selectedOptions: normalizedSelected,
                        customAnswers: normalizedCustom,
                      },
                    }
                  : toolCall
              ),
            };
          })
        );
      }

      pendingUserQuestionRef.current.delete(questionId);
      reconcilePendingUserQuestionConversationIds();
      userQuestionTargetRef.current.delete(pending.interactionId);
      pending.resolve(
        JSON.stringify({
          cancelled,
          answers,
          selectedOptions: normalizedSelected,
          customAnswers: normalizedCustom,
        })
      );
    },
    [
      pendingUserQuestionRef,
      reconcilePendingUserQuestionConversationIds,
      updateSessionMessages,
      userQuestionTargetRef,
    ]
  );

  const answerUserQuestion = useCallback(
    (
      questionId: string,
      selectedOptions: string[],
      customAnswers: string[]
    ): void => {
      settleUserQuestion(questionId, false, selectedOptions, customAnswers);
    },
    [settleUserQuestion]
  );

  const cancelUserQuestion = useCallback(
    (questionId: string): void => {
      settleUserQuestion(questionId, true, [], []);
    },
    [settleUserQuestion]
  );

  const rejectPendingUserQuestions = useCallback(
    (sessionKey?: string): void => {
      interruptPendingUserQuestions("User question interrupted", sessionKey);
    },
    [interruptPendingUserQuestions]
  );

  const getUserQuestionDraft = useCallback(
    (questionId: string): UserQuestionDraft | undefined =>
      userQuestionDraftsRef.current.get(questionId),
    []
  );

  const saveUserQuestionDraft = useCallback(
    (questionId: string, draft: UserQuestionDraft): void => {
      userQuestionDraftsRef.current.set(questionId, draft);
    },
    []
  );

  const clearUserQuestionDraft = useCallback((questionId: string): void => {
    userQuestionDraftsRef.current.delete(questionId);
  }, []);

  return {
    settleUserQuestion,
    answerUserQuestion,
    cancelUserQuestion,
    rejectPendingUserQuestions,
    getUserQuestionDraft,
    saveUserQuestionDraft,
    clearUserQuestionDraft,
  };
};
