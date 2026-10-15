import { useEffect, useRef } from "react";
import type { ChatInputSendOptions } from "../../chatInput/types";
import { buildConversationMessages } from "../utils/conversationHelpers";
import {
  CHAT_MESSAGE_PAGE_SIZE,
  type ConversationContextValue,
} from "../utils/conversationTypes";
import { tokenUsageFromMessageRecords } from "./useConversationManagement";

export type ConversationMessageReceipt = {
  conversationId: string;
  /** started: the target turn begins now; queued: it joins the target's queue. */
  status: "started" | "queued";
};

type ConversationMessageSender = (
  conversationId: string,
  text: string,
) => Promise<ConversationMessageReceipt>;

let activeSender: ConversationMessageSender | null = null;

/**
 * 向任意主会话投递用户消息（插件会话编排）。目标不必是当前视图会话：
 * 会话未在内存中时先后台加载历史与模式，再走与普通发送一致的代理循环；
 * 目标正在运行时消息进入其待发队列，由循环在回合结束后自动发出。
 */
export const sendMessageToConversation = (
  conversationId: string,
  text: string,
): Promise<ConversationMessageReceipt> => {
  if (!activeSender) {
    return Promise.reject(new Error("Chat runtime is not ready"));
  }
  return activeSender(conversationId, text);
};

const prepareBackgroundSession = async (
  ctx: ConversationContextValue,
  conversationId: string,
): Promise<void> => {
  const record = await window.snow.getChatConversation(conversationId);
  if (!record) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }
  if (
    record.parentConversationId ||
    record.conversationType === "sub_agent" ||
    record.conversationType === "workflow_node"
  ) {
    throw new Error(
      "Only top-level conversations can receive messages from plugins",
    );
  }
  // 与进行中的视图加载共享同一请求，避免重复拉取并覆盖其结果。
  await ctx.historyLoadPromisesRef.current.get(conversationId);
  if (ctx.sessionsRef.current[conversationId]) {
    return;
  }

  const [page, modes] = await Promise.all([
    window.snow.listChatMessagesPaginated(
      conversationId,
      "",
      CHAT_MESSAGE_PAGE_SIZE,
    ),
    window.snow.getConversationModes(conversationId),
  ]);
  ctx.ensureSession(conversationId, record.directoryId || undefined);
  // 模式必须从库中恢复：发送时 persistConversationSelection 会按会话内存
  // 模式回写，若仍是全局默认值就会覆盖用户在该会话里设置的模式。
  const ref = ctx.sessionsRefData.current.get(conversationId);
  if (ref && modes) {
    ref.planMode = modes.planMode ?? ref.planMode;
    ref.goalMode = modes.goalMode ?? ref.goalMode;
    ref.worktreeMode = modes.worktreeMode ?? ref.worktreeMode;
    ref.workflowMode = modes.workflowMode ?? ref.workflowMode;
    ref.goalModeTokenBudget =
      modes.goalModeTokenBudget ?? ref.goalModeTokenBudget;
  }
  ctx.setSessions((sessions) => {
    const session = sessions[conversationId];
    if (!session || session.messages.length > 0) return sessions;
    return {
      ...sessions,
      [conversationId]: {
        ...session,
        messages: buildConversationMessages(page.items),
        messageRecords: page.items,
        summary: record.title || record.summary,
        hasMoreMessages: page.hasMore,
        tokenUsage: tokenUsageFromMessageRecords(page.items),
      },
    };
  });
};

const deliverMessage = async (
  ctx: ConversationContextValue,
  conversationId: string,
  text: string,
): Promise<ConversationMessageReceipt> => {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Message text must not be blank");
  }
  await prepareBackgroundSession(ctx, conversationId);
  const wasBusy =
    ctx.sessionsRefData.current.get(conversationId)?.isSending === true;
  // 程序化发送省略 deliveryMode 时始终排队；会话空闲则直接开始新回合。
  const options: ChatInputSendOptions = { targetSessionKey: conversationId };
  ctx.handleSendMessageRef.current(trimmed, options);
  return { conversationId, status: wasBusy ? "queued" : "started" };
};

/**
 * 注册会话消息投递通道。挂在聊天上下文 Provider 上（应用常驻挂载），
 * 插件写动作经 sendMessageToConversation 进入这里。
 */
export const useConversationMessageBridge = (
  ctx: ConversationContextValue,
): void => {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  useEffect(() => {
    const sender: ConversationMessageSender = (conversationId, text) =>
      deliverMessage(ctxRef.current, conversationId, text);
    activeSender = sender;
    return () => {
      if (activeSender === sender) {
        activeSender = null;
      }
    };
  }, []);
};
