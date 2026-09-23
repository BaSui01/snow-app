import { memo } from "react";
import { AiResponse } from "./AiResponse";
import { CompactionMessage } from "./CompactionMessage";
import { UserMessage } from "./UserMessage";
import { HookExecutionUI } from "../toolCalls/HookExecutionUI";
import type {
  ChatConversationMessage,
  ToolCallInfo,
} from "../utils/conversationTypes";

export type MessageContentProps = {
  message: ChatConversationMessage;
  isStreaming: boolean;
  isAborting: boolean;
  lastAssistantMessageId: string | undefined;
  activeConversationId: string | undefined;
  canRollback: boolean;
  rollbackPreparingMessageId: string | null;
  pendingToolAuthorizations: ToolCallInfo[];
  onRollback: (messageId: string) => void;
  onFork: (conversationId: string, upToResponseId: string) => void;
  onApproveToolAuthorization: (toolCall: ToolCallInfo) => void;
  onApproveToolAuthorizationAlways: (toolCall: ToolCallInfo) => void;
  onRejectToolAuthorization: (
    toolCall: ToolCallInfo,
    reason: string,
    userProvidedReason?: boolean,
  ) => void;
};

/**
 * 单条消息的内容渲染（memo 化），配合 VirtualizedMessage 组成两道闸门。
 *
 * 流式期间会话统计字段（token 数/耗时）高频更新会让 context 值变化，
 * ChatMessageList 与 VirtualizedMessage 随之重新渲染——但历史消息的
 * message 引用保持稳定，memo 浅比较直接拦截，整棵消息子树（AiResponse、
 * 思考块、工具调用卡片）完全不会执行。只有最后一条流式消息的 message
 * 引用逐 token 变化，重渲染是必要的（内容确实在变）。
 *
 * 注意：所有 props 必须是稳定引用（useCallback / 低频 state），否则
 * memo 拦截形同虚设。
 */
export const MessageContent = memo(
  ({
    message,
    isStreaming,
    isAborting,
    lastAssistantMessageId,
    activeConversationId,
    canRollback,
    rollbackPreparingMessageId,
    pendingToolAuthorizations,
    onRollback,
    onFork,
    onApproveToolAuthorization,
    onApproveToolAuthorizationAlways,
    onRejectToolAuthorization,
  }: MessageContentProps): React.JSX.Element | null => {
    if (message.role === "user") {
      if (message.isContextCompaction) {
        return (
          <div className="chat-message-hook-container">
            <CompactionMessage
              content={message.content}
              isStreaming={isStreaming}
              canRollback={canRollback}
              isRollbackPreparing={rollbackPreparingMessageId === message.id}
              onRollback={() => onRollback(message.id)}
            />
            {message.hookExecutions && message.hookExecutions.length > 0 ? (
              <HookExecutionUI executions={message.hookExecutions} />
            ) : null}
          </div>
        );
      }

      return (
        <UserMessage
          content={message.content}
          isStreaming={isStreaming}
          canRollback={canRollback}
          isRollbackPreparing={rollbackPreparingMessageId === message.id}
          onRollback={() => onRollback(message.id)}
          hookExecutions={message.hookExecutions}
        />
      );
    }

    // Skip standalone tool messages — their results are already
    // rendered inside the preceding assistant message's ToolCallItem.
    if (message.role === "tool") {
      return null;
    }

    const isLastAssistant = message.id === lastAssistantMessageId;
    const hasToolCalls = (message.toolCalls?.length ?? 0) > 0;
    const isMessageStreaming = message.status === "sending";

    // Hook records bound to a tool call of this message (via
    // toolCallInteractionId) are rendered inside the tool card itself.
    // Only unbound records — or bound records whose card is not in this
    // message (should not happen) — stay in the message footer.
    const boundInteractionIds = new Set(
      (message.toolCalls ?? []).map((tc) => tc.interactionId),
    );
    const footerHookExecutions = (message.hookExecutions ?? []).filter(
      (record) =>
        !record.toolCallInteractionId ||
        !boundInteractionIds.has(record.toolCallInteractionId),
    );

    // - All assistant messages without tool calls (1-on-1 conversations)
    // - The last assistant message when it has tool calls (AI Loop ending)
    // - Never on a message that is currently streaming
    // - Never while the conversation-level streaming is active (AI Loop in
    //   progress). Without this guard, a message that finishes streaming
    //   but precedes a tool-call round would briefly show actions that
    //   vanish when the next assistant turn starts — causing a flash.
    const showActions =
      !isStreaming && !isMessageStreaming && (!hasToolCalls || isLastAssistant);

    return (
      <div className="chat-message-hook-container">
        <AiResponse
          isStreaming={message.status === "sending"}
          isAborting={isLastAssistant && isAborting}
          summary={message.content}
          thinking={message.thinking}
          thinkingDurationMs={message.thinkingDurationMs}
          thinkingTokenCount={message.thinkingTokenCount}
          isThinkingActive={message.isThinkingActive}
          incompleteVariant={message.incompleteVariant}
          interruptionReason={message.interruptionReason}
          recoveryOutcome={message.recoveryOutcome}
          showActions={showActions}
          toolCalls={message.toolCalls}
          hookExecutions={message.hookExecutions}
          pendingToolAuthorizations={
            isLastAssistant
              ? pendingToolAuthorizations.filter(
                  (toolCall) =>
                    toolCall.authorizationConversationId ===
                    activeConversationId,
                )
              : undefined
          }
          onApproveToolAuthorization={onApproveToolAuthorization}
          onApproveToolAuthorizationAlways={onApproveToolAuthorizationAlways}
          onRejectToolAuthorization={onRejectToolAuthorization}
          conversationId={activeConversationId}
          responseId={message.responseId}
          onFork={onFork}
        />
        {footerHookExecutions.length > 0 ? (
          <HookExecutionUI executions={footerHookExecutions} />
        ) : null}
      </div>
    );
  },
);

MessageContent.displayName = "MessageContent";
