import { useMemo } from "react";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  CircleDot,
  Loader2,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import { useChatConversationContext } from "../components/ChatConversationContext";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type SubAgentListToolCallProps = {
  toolCall: ToolCallInfo;
};

type SubAgentEntry = {
  conversationId: string;
  agentId: string;
  agentName: string;
  status: string;
  resumable: boolean;
};

type ParsedListResult =
  | { type: "success"; subAgents: SubAgentEntry[] }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseResult = (result: string | undefined): ParsedListResult => {
  if (!result) {
    return { type: "empty" };
  }
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }
    if (typeof parsed.error === "string") {
      return { type: "error", message: parsed.error };
    }
    if (parsed.success === true && Array.isArray(parsed.subAgents)) {
      const subAgents: SubAgentEntry[] = parsed.subAgents
        .filter(isRecord)
        .map((item) => ({
          conversationId:
            typeof item.conversationId === "string" ? item.conversationId : "",
          agentId: typeof item.agentId === "string" ? item.agentId : "",
          agentName: typeof item.agentName === "string" ? item.agentName : "",
          status: typeof item.status === "string" ? item.status : "",
          resumable: item.resumable === true,
        }))
        .filter((item) => item.conversationId || item.agentId);
      return { type: "success", subAgents };
    }
    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

/** sub-agents-listSubAgents 专用渲染：展示当前会话的子代理查询结果
 * （含已结束的持久化记录），带运行状态、可恢复标记与跳转入口。 */
export const SubAgentListToolCall = ({
  toolCall,
}: SubAgentListToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const { handleSelectConversation, activeConversationId } =
    useChatConversationContext();

  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result]
  );

  const isRunning = toolCall.status === "running";
  const isError = parsedResult.type === "error" || toolCall.status === "error";
  const effectiveStatus = isError ? "error" : toolCall.status;

  const statusLabel = (status: string): string => {
    switch (status) {
      case "running":
        return t("toolCall.subAgentList.status.running");
      case "completed":
        return t("toolCall.subAgentList.status.completed");
      case "failed":
        return t("toolCall.subAgentList.status.failed");
      case "cancelled":
        return t("toolCall.subAgentList.status.cancelled");
      default:
        return status || "-";
    }
  };

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.subAgentList.name")}
      category="agent"
      displayName={t("toolCall.subAgentList.name")}
      status={effectiveStatus}
      className="tool-call-sub-agent-list"
    >
      <div className="tool-call-body tool-call-sub-agent-list-body">
        {/* Pending state */}
        {parsedResult.type === "empty" ? (
          <div className="tool-call-sub-agent-pending">
            {isRunning ? (
              <Loader2
                className="tool-call-icon-spinning"
                size={14}
                aria-hidden="true"
              />
            ) : (
              <Bot size={14} aria-hidden="true" />
            )}
            <span>{t("toolCall.subAgentList.loading")}</span>
          </div>
        ) : null}

        {/* Agent list */}
        {parsedResult.type === "success" ? (
          <div className="tool-call-sub-agent-list-content">
            <span className="tool-call-sub-agent-list-count">
              {t("toolCall.subAgentList.count", {
                values: { count: parsedResult.subAgents.length },
              })}
            </span>
            {parsedResult.subAgents.length > 0 ? (
              <ul className="tool-call-sub-agent-list-items">
                {parsedResult.subAgents.map((agent) => {
                  const isActive = activeConversationId === agent.conversationId;
                  const displayName = agent.agentName || agent.agentId || "-";
                  return (
                    <li key={agent.conversationId} className="tool-call-sub-agent-list-item">
                      <Bot size={12} aria-hidden="true" />
                      <span
                        className="tool-call-sub-agent-list-item-name"
                        title={agent.conversationId}
                      >
                        {displayName}
                      </span>
                      <span
                        className={`tool-call-sub-agent-list-item-status tool-call-sub-agent-list-item-status-${agent.status}`}
                      >
                        {statusLabel(agent.status)}
                      </span>
                      <span
                        className={`tool-call-sub-agent-list-item-resumable ${
                          agent.resumable
                            ? "tool-call-sub-agent-list-item-resumable--yes"
                            : "tool-call-sub-agent-list-item-resumable--no"
                        }`}
                      >
                        {agent.resumable
                          ? t("toolCall.subAgentList.resumable")
                          : t("toolCall.subAgentList.notResumable")}
                      </span>
                      {agent.conversationId ? (
                        <button
                          type="button"
                          className={`tool-call-sub-agent-list-item-jump ${
                            isActive ? "active" : ""
                          }`}
                          onClick={() => {
                            void handleSelectConversation(agent.conversationId);
                          }}
                        >
                          <ArrowRight size={12} aria-hidden="true" />
                          {t("toolCall.subAgentList.jump")}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="tool-call-sub-agent-list-empty">
                <CircleDot size={12} aria-hidden="true" />
                <span>{t("toolCall.subAgentList.empty")}</span>
              </div>
            )}
          </div>
        ) : null}

        {/* Error */}
        {parsedResult.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {/* Raw result fallback */}
        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.subAgent.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
