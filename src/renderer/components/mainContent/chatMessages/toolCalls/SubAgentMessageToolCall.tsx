import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowRight, Bot } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { useChatConversationContext } from "../components/ChatConversationContext";
import { PromptPreview } from "../components/PromptPreview";
import { useSubAgentRuns } from "../hooks/subAgentRuntimeClient";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";
import { ToolResultView } from "./shared/ToolResultView";
import { localizeToolError } from "./shared/toolErrorDisplay";
import { SubAgentMessageDelivery } from "./SubAgentMessageDelivery";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const parseObject = (raw?: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(raw ?? "");
    return record(value) ? value : null;
  } catch {
    return null;
  }
};

/** Current peer messaging addresses an exact run, never a conversation alias. */
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
  const senderId = conversationId ?? activeConversationId ?? "";
  const [identity, setIdentity] = useState<{
    senderId: string;
    parentId: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (!senderId) return;
    void window.snow.getChatConversation(senderId).then(
      (sender) => {
        if (!active) return;
        setIdentity(
          sender?.conversationType === "sub_agent" &&
            sender.parentConversationId
            ? { senderId, parentId: sender.parentConversationId }
            : null,
        );
      },
      () => {
        if (active) setIdentity(null);
      },
    );
    return () => {
      active = false;
    };
  }, [senderId]);
  const parentId =
    identity?.senderId === senderId ? identity.parentId : undefined;
  const { runs } = useSubAgentRuns(parentId);
  const args = useMemo(
    () => parseObject(toolCall.arguments),
    [toolCall.arguments],
  );
  const result = useMemo(() => parseObject(toolCall.result), [toolCall.result]);
  const recipientRunId =
    typeof args?.recipientRunId === "string" ? args.recipientRunId : "";
  const target = runs.find(
    (run) =>
      run.runId === recipientRunId && run.parentConversationId === parentId,
  );
  const error = typeof result?.error === "string" ? result.error : null;
  const queued =
    result?.success === true &&
    result.kind === "message_queued" &&
    result.deliveryStatus === "queued" &&
    result.runId === recipientRunId &&
    typeof result.conversationId === "string" &&
    typeof result.messageId === "string" &&
    typeof result.queuedAt === "number";
  const jumpTargetId =
    queued && target && target.conversationId === result.conversationId
      ? target.conversationId
      : undefined;
  const senderName =
    subAgentSessionEvents[senderId]?.agentName ||
    t("toolCall.subAgentComms.self");
  const recipientName = target?.agentName || recipientRunId;
  const message = typeof args?.message === "string" ? args.message : "";
  return (
    <ToolCallNode
      toolName={toolCall.name}
      category="agent"
      displayName={`${senderName} → ${recipientName}`}
      displayNameTitle={recipientRunId || undefined}
      status={error ? "error" : toolCall.status}
      className="tool-call-sub-agent"
    >
      <div className="tool-call-body tool-call-sub-agent-body">
        <div className="tool-call-sub-agent-comms-route">
          <span className="tool-call-sub-agent-comms-party" title={senderId}>
            <Bot size={12} aria-hidden="true" />
            <span>{senderName}</span>
          </span>
          <ArrowRight size={12} aria-hidden="true" />
          {jumpTargetId ? (
            <button
              type="button"
              className="tool-call-sub-agent-comms-party"
              onClick={() => void handleSelectConversation(jumpTargetId)}
            >
              <Bot size={12} aria-hidden="true" />
              <span>{recipientName}</span>
            </button>
          ) : (
            <span
              className="tool-call-sub-agent-comms-party"
              title={recipientRunId}
            >
              <Bot size={12} aria-hidden="true" />
              <span>{recipientName}</span>
            </span>
          )}
        </div>
        {message ? (
          <PromptPreview
            text={message}
            label={t("toolCall.subAgentContinue.message")}
          />
        ) : null}
        {queued ? (
          <SubAgentMessageDelivery
            messageId={result.messageId as string}
            queuedAt={result.queuedAt as number}
          />
        ) : error ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{localizeToolError(t, error)}</span>
          </div>
        ) : toolCall.result ? (
          <ToolResultView value={result ?? toolCall.result} />
        ) : null}
      </div>
    </ToolCallNode>
  );
};
