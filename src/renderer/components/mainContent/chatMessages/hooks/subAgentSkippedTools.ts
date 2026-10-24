import type {
  ConversationContextValue,
  ToolCallInfo,
} from "../utils/conversationTypes";
import { updateFirstMatchingToolCall } from "../utils/conversationHelpers";

/** Close the tool-call history without executing any remaining side effects. */
export const recordSkippedSubAgentTools = (
  ctx: ConversationContextValue,
  conversationId: string,
  assistantMessageId: string,
  calls: ToolCallInfo[],
  evidence: (call: ToolCallInfo, result: string) => string,
): { name: string; callId: string; result: string }[] => {
  if (!calls.length) return [];
  const result = JSON.stringify({
    success: false,
    error: "TOOL_NOT_EXECUTED",
    reason: "Sub-agent run stopped before this tool was executed.",
  });
  const results = calls.map((call) => ({
    name: call.name,
    callId: call.callId || "",
    result: evidence(call, result),
  }));
  ctx.updateSessionMessages(conversationId, (messages) =>
    messages.map((message) => {
      if (message.id !== assistantMessageId) return message;
      let toolCalls = message.toolCalls;
      for (const call of calls) {
        toolCalls = updateFirstMatchingToolCall(
          toolCalls,
          call,
          ["pending"],
          (tool) => ({ ...tool, status: "error" as const, result }),
        );
      }
      return { ...message, toolCalls };
    }),
  );
  return results;
};
