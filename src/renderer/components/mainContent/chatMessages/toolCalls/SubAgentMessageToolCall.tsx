import { useMemo } from "react";
import { AlertCircle, ArrowRight, Bot } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { useChatConversationContext } from "../components/ChatConversationContext";
import { PromptPreview } from "../components/PromptPreview";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";
import { localizeToolError } from "./shared/toolErrorDisplay";
import { SubAgentMessageDelivery } from "./SubAgentMessageDelivery";

type ParsedArgs = { conversationId: string; message: string };

type ParsedResult =
  | {
      type: "queued";
      messageId?: string;
      queuedAt?: number;
      recipientName: string;
    }
  | { type: "error"; message: string }
  | { type: "empty" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseArgs = (args: string): ParsedArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed)) return null;
    return {
      conversationId:
        typeof parsed.conversationId === "string" ? parsed.conversationId : "",
      message: typeof parsed.message === "string" ? parsed.message : "",
    };
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedResult => {
  if (!result) return { type: "empty" };
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) return { type: "error", message: result };
    if (typeof parsed.error === "string") {
      return { type: "error", message: parsed.error };
    }
    const recipient = isRecord(parsed.recipient) ? parsed.recipient : {};
    return {
      type: "queued",
      messageId:
        typeof parsed.messageId === "string" ? parsed.messageId : undefined,
      queuedAt:
        typeof parsed.queuedAt === "number" ? parsed.queuedAt : undefined,
      recipientName:
        typeof recipient.agentName === "string" ? recipient.agentName : "",
    };
  } catch {
    return { type: "error", message: result };
  }
};

/** sub-agents-sendMessage：发送方 → 接收方、入队时间与送达状态。 */
export const SubAgentMessageToolCall = ({
  toolCall,
  conversationId,
}: {
  toolCall: ToolCallInfo;
  conversationId?: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const {
    activeConversationId,
    subAgentSessionEvents,
    handleSelectConversation,
  } = useChatConversationContext();

  const args = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const result = useMemo(() => parseResult(toolCall.result), [toolCall.result]);

  const senderId = conversationId ?? activeConversationId ?? "";
  const senderEvent = senderId ? subAgentSessionEvents[senderId] : undefined;
  const targetId = args?.conversationId ?? "";
  const targetEvent = targetId ? subAgentSessionEvents[targetId] : undefined;

  const senderName = senderEvent?.agentName || t("toolCall.subAgentComms.self");
  const recipientName =
    (result.type === "queued" ? result.recipientName : "") ||
    targetEvent?.agentName ||
    targetId;
  // 会话隔离：仅同一父会话下的队友可跳转
  const canJump =
    !!targetEvent &&
    !!senderEvent &&
    targetEvent.parentConversationId === senderEvent.parentConversationId;

  const status =
    result.type === "error" || toolCall.status === "error"
      ? "error"
      : toolCall.status;

  return (
    <ToolCallNode
      toolName={toolCall.name}
      category="agent"
      displayName={`${senderName} → ${recipientName}`}
      displayNameTitle={targetId || undefined}
      status={status}
      className="tool-call-sub-agent"
    >
      <div className="tool-call-body tool-call-sub-agent-body">
        <div className="tool-call-sub-agent-comms-route">
          <span className="tool-call-sub-agent-comms-party" title={senderId}>
            <Bot size={12} aria-hidden="true" />
            <span>{senderName}</span>
          </span>
          <ArrowRight size={12} aria-hidden="true" />
          {canJump ? (
            <button
              type="button"
              className="tool-call-sub-agent-comms-party"
              title={targetId}
              onClick={() => void handleSelectConversation(targetId)}
            >
              <Bot size={12} aria-hidden="true" />
              <span>{recipientName}</span>
            </button>
          ) : (
            <span className="tool-call-sub-agent-comms-party" title={targetId}>
              <Bot size={12} aria-hidden="true" />
              <span>{recipientName}</span>
            </span>
          )}
        </div>

        {args?.message ? (
          <PromptPreview
            text={args.message}
            label={t("toolCall.subAgentContinue.message")}
          />
        ) : null}

        {result.type === "queued" ? (
          <SubAgentMessageDelivery
            messageId={result.messageId}
            queuedAt={result.queuedAt}
          />
        ) : null}

        {result.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{localizeToolError(t, result.message)}</span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
