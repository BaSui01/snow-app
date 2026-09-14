import { Check, CircleX, Loader2, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import { useI18n } from "../../../../i18n";
import { useChatConversationContext } from "../components/ChatConversationContext";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolNameBadge } from "./shared/ToolNameBadge";

type PlanModeApprovalToolCallProps = {
  toolCall: ToolCallInfo;
};

type PlanApprovalResult = {
  approved: boolean;
};

const APPROVE_OPTION = "Approve and execute the plan";
const KEEP_PLANNING_OPTION = "Keep planning";

const parseApprovalResult = (
  resultJson: string | undefined,
): PlanApprovalResult | null => {
  if (!resultJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(resultJson) as Record<string, unknown>;
    return typeof parsed.approved === "boolean"
      ? { approved: parsed.approved }
      : null;
  } catch {
    return null;
  }
};

export const PlanModeApprovalToolCall = ({
  toolCall,
}: PlanModeApprovalToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const { answerUserQuestion } = useChatConversationContext();
  const questionState = toolCall.userQuestion;
  const parsedResult = useMemo(
    () => parseApprovalResult(toolCall.result),
    [toolCall.result],
  );
  const approved = parsedResult?.approved === true;
  const declined = parsedResult?.approved === false;
  const isWaitingForRequest = toolCall.status === "running" && !questionState;
  // 与 AskUserQuestion 卡片同一套泄漏防护：工具已结束却未通过 approved /
  // declined 协议结算（提问通道被中断、工具以错误 JSON 结束）时，必须显示
  // 终态并禁用交互，否则卡片停在"等待回答"且按钮点击没有任何反馈。
  const isInterrupted =
    questionState?.interrupted === true ||
    (questionState?.status === "waiting" && toolCall.status === "completed");
  const isInteractive = Boolean(
    questionState &&
    questionState.status === "waiting" &&
    parsedResult === null &&
    !isInterrupted &&
    (toolCall.status === "running" || toolCall.status === "pending"),
  );

  const submitDecision = (approvedDecision: boolean): void => {
    if (!questionState || !isInteractive) {
      return;
    }

    answerUserQuestion(
      questionState.questionId,
      [approvedDecision ? APPROVE_OPTION : KEEP_PLANNING_OPTION],
      [],
    );
  };

  const statusLabel = isInterrupted
    ? t("toolCall.userQuestion.status.interrupted")
    : approved
      ? t("toolCall.planApproval.status.approved")
      : declined
        ? t("toolCall.planApproval.status.declined")
        : toolCall.status === "error"
          ? t("toolCall.planApproval.status.error")
          : t("toolCall.planApproval.status.waiting");

  return (
    <div className="tool-call-item tool-call-plan-approval">
      <div className="tool-call-header">
        <ToolNameBadge
          name={t("toolCall.planApproval.name")}
          category="interaction"
        />
        {isInterrupted ? (
          <CircleX size={14} aria-hidden="true" />
        ) : approved ? (
          <Check size={14} aria-hidden="true" />
        ) : declined ? (
          <CircleX size={14} aria-hidden="true" />
        ) : isWaitingForRequest || toolCall.status === "running" ? (
          <Loader2
            className="tool-call-icon-spinning"
            size={14}
            aria-hidden="true"
          />
        ) : (
          <ShieldCheck size={14} aria-hidden="true" />
        )}
        <span className="tool-call-name">
          {t("toolCall.planApproval.action")}
        </span>
        <span
          className={`tool-call-status tool-call-status-${
            isInterrupted || toolCall.status === "error"
              ? "error"
              : approved
                ? "completed"
                : declined
                  ? "cancelled"
                  : "running"
          }`}
          role="status"
          aria-live="polite"
        >
          {statusLabel}
        </span>
      </div>

      <div className="tool-call-body tool-call-plan-approval-body">
        <div className="tool-call-plan-approval-heading">
          <ShieldCheck size={18} aria-hidden="true" />
          <div>
            <strong>{t("toolCall.planApproval.title")}</strong>
            <p>{t("toolCall.planApproval.description")}</p>
          </div>
        </div>

        {isWaitingForRequest ? (
          <div className="tool-call-user-question-waiting">
            <Loader2
              className="tool-call-icon-spinning"
              size={14}
              aria-hidden="true"
            />
            <span>{t("toolCall.planApproval.preparing")}</span>
          </div>
        ) : null}

        {toolCall.status === "error" && toolCall.result ? (
          <div className="tool-call-error">
            <span>{toolCall.result}</span>
          </div>
        ) : null}

        <div className="tool-call-plan-approval-footer">
          <span>
            {isInterrupted
              ? t("toolCall.planApproval.interruptedHint")
              : approved
                ? t("toolCall.planApproval.approvedHint")
                : declined
                  ? t("toolCall.planApproval.declinedHint")
                  : t("toolCall.planApproval.waitingHint")}
          </span>
          {isInteractive ? (
            <div className="tool-call-plan-approval-actions">
              <button
                type="button"
                className="tool-call-plan-approval-continue"
                onClick={() => submitDecision(false)}
              >
                <CircleX size={14} aria-hidden="true" />
                <span>{t("toolCall.planApproval.continuePlanning")}</span>
              </button>
              <button
                type="button"
                className="tool-call-plan-approval-approve"
                onClick={() => submitDecision(true)}
              >
                <Check size={14} aria-hidden="true" />
                <span>{t("toolCall.planApproval.approve")}</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
