import {
  AlertCircle,
  Ban,
  CheckCircle2,
  CircleQuestionMark,
} from "lucide-react";
import { useId } from "react";
import { useI18n } from "../../../../i18n";
import {
  isSubAgentTerminal,
  type SubAgentCancelReceipt,
  type SubAgentResultPage,
  type SubAgentRunAcceptance,
  type SubAgentRunRecord,
} from "../../../../../shared/subAgentRuns";
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

type SubAgentRunDetailsProps = {
  run: SubAgentRunRecord;
  page?: SubAgentResultPage["summaryPage"];
  loadingResult: boolean;
  busyAction: boolean;
  queryError: string | null;
  actionError: string | null;
  cancelReceipt: SubAgentCancelReceipt | null;
  continueReceipt: string | null;
  message: string;
  pendingContinue: boolean;
  onMessageChange: (message: string) => void;
  onLoadResult: (offset?: number) => void;
  onCancel: () => void;
  onContinue: () => void;
  onOpenConversation: () => void;
};

export const SubAgentRunDetails = ({
  run,
  page,
  loadingResult,
  busyAction,
  queryError,
  actionError,
  cancelReceipt,
  continueReceipt,
  message,
  pendingContinue,
  onMessageChange,
  onLoadResult,
  onCancel,
  onContinue,
  onOpenConversation,
}: SubAgentRunDetailsProps): React.JSX.Element => {
  const { t } = useI18n();
  const messageId = useId();
  const terminal = isSubAgentTerminal(run.status);
  const error = run.outcome?.error;
  const acceptance = run.outcome?.acceptance;
  const canCancel =
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "waiting_input";
  const canContinue =
    terminal || run.status === "running" || run.status === "waiting_input";
  const preview = (run.outcome?.summary ?? "").slice(0, 320);
  const nextOffset = page?.nextOffset;
  const times = [
    ["acceptedAt", run.acceptedAt],
    ["startedAt", run.startedAt],
    ["completedAt", run.completedAt],
  ] as const;
  return (
    <section className="sub-agent-run" aria-label={t("subAgentRun.title")}>
      <div className="sub-agent-run-badges" role="status">
        <span>{t(`subAgentRun.mode.${run.executionMode}`)}</span>
        <strong data-run-status={run.status}>
          {t(`subAgentRun.status.${run.status}`)}
        </strong>
      </div>
      <p>{t(`subAgentRun.hint.${run.status}`)}</p>
      {run.waitingReason ? (
        <p>{t(`subAgentRun.waiting.${run.waitingReason}`)}</p>
      ) : null}
      <dl className="sub-agent-run-metadata">
        <div>
          <dt>{t("subAgentRun.runId")}</dt>
          <dd>{run.runId}</dd>
        </div>
        {times.map(([label, timestamp]) =>
          timestamp === undefined ? null : (
            <div key={label}>
              <dt>{t(`subAgentRun.${label}`)}</dt>
              <dd>
                <time dateTime={new Date(timestamp).toISOString()}>
                  {new Date(timestamp).toLocaleString()}
                </time>
              </dd>
            </div>
          ),
        )}
        {run.startedAt !== undefined && run.completedAt !== undefined ? (
          <div>
            <dt>{t("subAgentRun.duration")}</dt>
            <dd>
              {t("subAgentRun.durationValue", {
                values: {
                  seconds: ((run.completedAt - run.startedAt) / 1000).toFixed(
                    1,
                  ),
                },
              })}
            </dd>
          </div>
        ) : null}
      </dl>
      {run.deliveryStatus ? (
        <p className="sub-agent-run-notice">
          {t(`subAgentRun.delivery.${run.deliveryStatus}`)}
        </p>
      ) : null}
      {run.status === "completed" &&
      run.outcome?.acceptanceSatisfied === false ? (
        <p className="sub-agent-run-warning">
          {t("subAgentRun.acceptanceUnmet")}
        </p>
      ) : null}
      {error ? (
        <div className="sub-agent-run-error" role="alert">
          <strong>{t(`subAgentRun.errorCategory.${error.category}`)}</strong>
          <p>{error.message}</p>
          <p>{t("subAgentRun.errorNextStep")}</p>
          <details>
            <summary>{t("subAgentRun.errorDetails")}</summary>
            <code>{error.code}</code>
            {error.detail ? <pre>{error.detail}</pre> : null}
            <p>
              {t(
                error.retryable
                  ? "subAgentRun.retryable"
                  : "subAgentRun.notRetryable",
              )}
            </p>
          </details>
        </div>
      ) : null}
      {acceptance ? (
        <SubAgentAcceptanceDetails acceptance={acceptance} />
      ) : null}
      {run.outcome && run.outcome.hookOutcome.kind !== "none" ? (
        <div className="sub-agent-run-notice">
          <strong>
            {t(`subAgentRun.hook.${run.outcome.hookOutcome.kind}`)}
          </strong>
          {run.outcome.hookOutcome.message ? (
            <p>{run.outcome.hookOutcome.message}</p>
          ) : null}
        </div>
      ) : null}
      {run.outcome && run.outcome.unavailableTools.length > 0 ? (
        <details>
          <summary>{t("subAgentRun.unavailableTools")}</summary>
          <ul>
            {run.outcome.unavailableTools.map((tool) => (
              <li key={tool.name}>
                <code>{tool.name}</code>: {tool.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="sub-agent-run-actions">
        <button
          type="button"
          disabled={loadingResult}
          onClick={() => onLoadResult(0)}
        >
          {t("subAgentRun.viewResult")}
        </button>
        <button type="button" onClick={onOpenConversation}>
          {t(
            run.status === "waiting_input"
              ? "subAgentRun.handleInput"
              : "toolCall.subAgent.jumpToConversation",
          )}
        </button>
        {canCancel ? (
          <button type="button" disabled={busyAction} onClick={onCancel}>
            {t("subAgentRun.cancel")}
          </button>
        ) : null}
      </div>
      {cancelReceipt ? (
        <p role="status">
          {t(`subAgentRun.cancel.${cancelReceipt.disposition}`)}
        </p>
      ) : null}
      {loadingResult ? <p role="status">{t("subAgentRun.loading")}</p> : null}
      {queryError ? (
        <div className="sub-agent-run-error" role="alert">
          {t("subAgentRun.queryFailed")}
          <pre>{queryError}</pre>
        </div>
      ) : null}
      {page ? (
        <section aria-label={t("toolCall.subAgent.result")}>
          <p>
            {t("subAgentRun.page", {
              values: {
                offset: page.offset,
                end: page.offset + Array.from(page.text).length,
                total: page.total,
              },
            })}
          </p>
          <pre className="sub-agent-run-result" tabIndex={0}>
            {page.text}
          </pre>
          <div className="sub-agent-run-actions">
            {page.offset > 0 ? (
              <button
                type="button"
                disabled={loadingResult}
                onClick={() => onLoadResult(0)}
              >
                {t("subAgentRun.firstPage")}
              </button>
            ) : null}
            {nextOffset !== undefined && nextOffset !== null ? (
              <button
                type="button"
                disabled={loadingResult}
                onClick={() => onLoadResult(nextOffset)}
              >
                {t("subAgentRun.nextPage")}
              </button>
            ) : null}
          </div>
        </section>
      ) : preview ? (
        <pre className="sub-agent-run-result">
          {preview}
          {(run.outcome?.summary.length ?? 0) > preview.length ? "…" : ""}
        </pre>
      ) : null}
      {canContinue || pendingContinue ? (
        <form
          className="sub-agent-run-continue"
          onSubmit={(event) => {
            event.preventDefault();
            onContinue();
          }}
        >
          <label htmlFor={messageId}>
            {t(terminal ? "subAgentRun.continue" : "subAgentRun.sendMessage")}
          </label>
          <textarea
            id={messageId}
            rows={3}
            value={message}
            readOnly={pendingContinue}
            onChange={(event) => onMessageChange(event.target.value)}
            required
          />
          <p>
            {t(
              pendingContinue
                ? "subAgentRun.retrySameRequest"
                : "subAgentRun.continueHint",
            )}
          </p>
          <button type="submit" disabled={busyAction || !message.trim()}>
            {t(
              pendingContinue
                ? "subAgentRun.retryRequest"
                : terminal
                  ? "subAgentRun.continue"
                  : "subAgentRun.sendMessage",
            )}
          </button>
        </form>
      ) : null}
      {actionError ? (
        <div className="sub-agent-run-error" role="alert">
          {t("subAgentRun.actionFailed")}
          <pre>{actionError}</pre>
        </div>
      ) : null}
      {continueReceipt ? (
        <details>
          <summary>{t("subAgentRun.continueReceipt")}</summary>
          <pre>{continueReceipt}</pre>
        </details>
      ) : null}
    </section>
  );
};
