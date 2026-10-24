import {
  AlertCircle,
  Ban,
  CheckCircle2,
  CircleQuestionMark,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { SubAgentRunAcceptance } from "../../../../../shared/subAgentRuns";
import "./SubAgentRunDetails.css";

/** Display only: persistence and runtime ownership stay with the caller. */
export const SubAgentAcceptanceDetails = ({
  acceptance,
}: {
  acceptance: SubAgentRunAcceptance;
}): React.JSX.Element => {
  const { t } = useI18n();
  const renderAcceptanceIcon = (
    status: SubAgentRunAcceptance["items"][number]["status"],
  ): React.ReactNode => {
    if (status === "completed")
      return <CheckCircle2 size={12} aria-hidden="true" />;
    if (status === "incomplete")
      return <AlertCircle size={12} aria-hidden="true" />;
    if (status === "blocked") return <Ban size={12} aria-hidden="true" />;
    return <CircleQuestionMark size={12} aria-hidden="true" />;
  };
  return (
    <div className="tool-call-sub-agent-acceptance">
      <div className="tool-call-sub-agent-acceptance-head">
        <span className="tool-call-sub-agent-acceptance-label">
          {t("toolCall.subAgent.acceptance.title")}
        </span>
        <span
          className={`tool-call-sub-agent-acceptance-verdict${
            acceptance.satisfied ? " is-passed" : " is-unmet"
          }`}
        >
          {acceptance.satisfied
            ? t("toolCall.subAgent.acceptance.verdictPassed")
            : t("toolCall.subAgent.acceptance.verdictUnmet")}
        </span>
        <span className="tool-call-sub-agent-acceptance-count">
          {t("toolCall.subAgent.acceptance.count", {
            values: {
              completed: acceptance.counts.completed,
              total: acceptance.counts.total,
            },
          })}
        </span>
      </div>
      {acceptance.reportState === "invalid" ? (
        <div className="tool-call-sub-agent-acceptance-notice">
          {t("toolCall.subAgent.acceptance.reportInvalid")}
        </div>
      ) : acceptance.reportState === "none" ? (
        <div className="tool-call-sub-agent-acceptance-notice">
          {t("toolCall.subAgent.acceptance.reportMissing")}
        </div>
      ) : null}
      {acceptance.ignoredReportIds.length > 0 ? (
        <details>
          <summary>{t("subAgentRun.ignoredReportItems")}</summary>
          <pre>{acceptance.ignoredReportIds.join(", ")}</pre>
        </details>
      ) : null}
      <ul className="tool-call-sub-agent-acceptance-list">
        {acceptance.items.map((item) => {
          const reason =
            item.reasonCode === "not_reported"
              ? t("toolCall.subAgent.acceptance.reason.notReported")
              : item.reasonCode === "no_valid_evidence"
                ? t("toolCall.subAgent.acceptance.reason.noEvidence")
                : item.reason;
          return (
            <li
              key={item.id}
              className={`tool-call-sub-agent-acceptance-item tool-call-sub-agent-acceptance-item--${item.status}`}
            >
              <span
                className={`tool-call-sub-agent-acceptance-item-icon tool-call-sub-agent-acceptance-item-icon--${item.status}`}
              >
                {renderAcceptanceIcon(item.status)}
              </span>
              <div className="tool-call-sub-agent-acceptance-main">
                <div className="tool-call-sub-agent-acceptance-row">
                  <span className="tool-call-sub-agent-acceptance-description">
                    {item.description}
                  </span>
                  {item.required ? (
                    <span className="tool-call-sub-agent-acceptance-required">
                      {t("toolCall.subAgent.acceptance.required")}
                    </span>
                  ) : null}
                  <span
                    className={`tool-call-sub-agent-acceptance-status tool-call-sub-agent-acceptance-status--${item.status}`}
                  >
                    {t(`toolCall.subAgent.acceptance.status.${item.status}`)}
                  </span>
                </div>
                <span className="tool-call-sub-agent-acceptance-id">
                  {item.id}
                </span>
                {item.observation ? (
                  <div className="tool-call-sub-agent-acceptance-observation">
                    {item.observation}
                  </div>
                ) : null}
                {reason ? (
                  <div className="tool-call-sub-agent-acceptance-reason">
                    {reason}
                  </div>
                ) : null}
                {acceptance.reportState === "received" &&
                !item.confirmedInLatestReport &&
                item.updatedAt > 0 ? (
                  <div className="tool-call-sub-agent-acceptance-reason">
                    {t("toolCall.subAgent.acceptance.previous")}
                  </div>
                ) : null}
                {item.invalidEvidenceIds.length > 0 ? (
                  <details>
                    <summary>{t("subAgentRun.ignoredEvidence")}</summary>
                    <pre>{item.invalidEvidenceIds.join(", ")}</pre>
                  </details>
                ) : null}
                {item.evidence.length > 0 ? (
                  <div className="tool-call-sub-agent-acceptance-evidence">
                    <span className="tool-call-sub-agent-acceptance-evidence-label">
                      {t("toolCall.subAgent.acceptance.evidence")}
                    </span>
                    {item.evidence.map((ref) => (
                      <details key={ref.id} className="sub-agent-run-evidence">
                        <summary>
                          {ref.id} · {ref.toolName} ·{" "}
                          {t(`subAgentRun.evidenceStatus.${ref.status}`)}
                        </summary>
                        <code>{ref.callId}</code>
                        {ref.preview ? <pre>{ref.preview}</pre> : null}
                      </details>
                    ))}
                  </div>
                ) : item.status === "completed" ? (
                  <div className="tool-call-sub-agent-acceptance-no-evidence">
                    {t("toolCall.subAgent.acceptance.noEvidence")}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
