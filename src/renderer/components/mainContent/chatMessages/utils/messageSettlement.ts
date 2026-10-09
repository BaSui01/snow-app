import type { ChatConversationMessage } from "./conversationTypes";

/**
 * 中止（用户停止 / 级联中止子代理与工作流节点）时的消息收尾，幂等。
 *
 * 把仍停留在流式态的消息落定为已结束、清掉「重试进行中」标记，并把未结算的
 * 工具调用结算为中断错误。
 *
 * 三处共用同一份实现：`handleAbort`（用户点停止）、`abortSubAgentTree`（级联
 * 中止子代理/工作流节点）与 agent loop 的取消分支。agent loop 在
 * `isRunCancelled` 时会直接返回、不再更新消息，收尾完全依赖这里，所以这些
 * 路径必须保持同一语义，否则消息会残留 `sending` / `isRetrying`，表现为
 * 「转圈不消失、操作按钮不出现」。
 */
export const settleInterruptedMessages = (
  messages: ChatConversationMessage[],
): ChatConversationMessage[] =>
  messages.map((message) => ({
    ...message,
    status: message.status === "sending" ? "sent" : message.status,
    // 中止后不存在合法的「重试进行中」：无论消息当前是什么状态都清掉，
    // 否则最后一条 assistant 消息会一直显示「重试中」转圈。
    isRetrying: false,
    toolCalls: message.toolCalls?.map((toolCall) =>
      toolCall.status === "running" || toolCall.status === "pending"
        ? {
            ...toolCall,
            status: "error" as const,
            result: toolCall.result ?? "Interrupted by user",
          }
        : toolCall,
    ),
  }));
