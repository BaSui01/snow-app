import { useMemo } from "react";
import { AlertCircle, ArrowRight, Bot } from "lucide-react";
import { useI18n } from "../../../../i18n";
import {
  useChatConversationContext,
  useChatConversationSessions,
} from "../components/ChatConversationContext";
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
      recipientConversationId: string;
    }
  | { type: "error"; message: string }
  | { type: "empty" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 输入由下方正则限定为完整 JSON 字符/转义，未完成的转义不会进入解码。 */
const decodeJsonString = (value: string): string =>
  JSON.parse(`"${value}"`) as string;

/**
 * 解析 sub-agents-sendMessage 的参数。
 * 流式输出期间 arguments 可能还是半截 JSON（message 里还可能含转义引号），
 * 因此完整解析失败时用正则提前提取已经到达的字段，让卡片头部尽早有内容。
 */
const parseArgs = (raw: string | undefined): ParsedArgs | null => {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    return {
      conversationId:
        typeof parsed.conversationId === "string"
          ? parsed.conversationId.trim()
          : "",
      message: typeof parsed.message === "string" ? parsed.message : "",
    };
  } catch {
    // ID 必须完整闭合；正文可以只到达一部分。仅匹配完整转义，避免把
    // 末尾的反斜杠、半截 \uXXXX 或字面量 \\n 错解码成其他内容。
    const conversationMatch = raw.match(
      /"conversationId"\s*:\s*"((?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*)"/,
    );
    const messageMatch = raw.match(
      /"message"\s*:\s*"((?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*)/,
    );
    if (!conversationMatch && !messageMatch) return null;
    return {
      conversationId: conversationMatch
        ? decodeJsonString(conversationMatch[1]).trim()
        : "",
      message: messageMatch ? decodeJsonString(messageMatch[1]) : "",
    };
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
      recipientConversationId:
        typeof recipient.conversationId === "string"
          ? recipient.conversationId
          : "",
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
  const sessions = useChatConversationSessions();

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
  // 会话隔离：仅同一父会话下的队友可跳转。实时事件只存在于内存，重启后
  // 目标会话仍可凭成功回执里的 recipient.conversationId 或已加载的历史
  // 佐证——请求参数（可能还没发送成功）不参与导航判定。
  const jumpTargetId =
    (result.type === "queued" ? result.recipientConversationId : "") ||
    (targetEvent ? targetId : "");
  const canJump =
    !!jumpTargetId &&
    (targetEvent
      ? targetEvent.parentConversationId === senderEvent?.parentConversationId
      : sessions[jumpTargetId]?.isInitialHistoryLoaded === true);

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
              className={`tool-call-sub-agent-comms-party ${
                activeConversationId === jumpTargetId ? "active" : ""
              }`}
              title={jumpTargetId}
              onClick={() => void handleSelectConversation(jumpTargetId)}
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
