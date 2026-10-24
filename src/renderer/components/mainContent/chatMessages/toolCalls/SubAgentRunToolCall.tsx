import { useMemo, useState } from "react";
import "../../../../themes/tool-cards.css";
import {
  AlertCircle,
  Ban,
  Bot,
  CheckCircle2,
  ChevronRight,
  Loader2,
} from "lucide-react";
import type { SubAgentRunStatus } from "../../../../../shared/subAgentRuns";
import { isSubAgentTerminal } from "../../../../../shared/subAgentRuns";
import { useI18n } from "../../../../i18n";
import { useChatConversationContext } from "../components/ChatConversationContext";
import { MarkdownBlock } from "../components/markdownRenderer";
import { useSubAgentRuns } from "../hooks/subAgentRuntimeClient";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { SubAgentRunActions } from "./SubAgentToolCall";
import { SubAgentAcceptanceDetails } from "../components/SubAgentRunDetails";
import { ToolCallNode } from "./shared/ToolCallNode";
import { ToolResultView } from "./shared/ToolResultView";
import { localizeToolError } from "./shared/toolErrorDisplay";
import {
  observeSubAgentRun,
  parseSubAgentObservationResult,
  type SubAgentRunObservation,
} from "./subAgentRunObservation";

const readArgs = (raw: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};
const readResultValue = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};
const statusTone = (status: SubAgentRunStatus): string => {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "interrupted") return "failed";
  if (status === "waiting_input") return "attention";
  if (status === "queued") return "pending";
  if (
    status === "running" ||
    status === "finalizing" ||
    status === "cancelling"
  )
    return "running";
  return "cancelled";
};
const statusIcon = (status: SubAgentRunStatus): React.ReactNode => {
  if (status === "waiting_input")
    return (
      <AlertCircle
        size={13}
        className="sub-agent-attention"
        aria-hidden="true"
      />
    );
  if (status === "completed")
    return (
      <CheckCircle2
        size={13}
        className="sub-agent-status-completed"
        aria-hidden="true"
      />
    );
  if (status === "failed" || status === "interrupted")
    return (
      <AlertCircle
        size={13}
        className="sub-agent-status-failed"
        aria-hidden="true"
      />
    );
  if (status === "cancelled") return <Ban size={13} aria-hidden="true" />;
  if (status !== "queued")
    return (
      <Loader2
        size={13}
        className="tool-call-icon-spinning"
        aria-hidden="true"
      />
    );
  return <Bot size={13} aria-hidden="true" />;
};

/** Mounted only on demand; read persisted identity before exposing existing run actions. */
const PersistedRunDetails = ({
  parentId,
  runId,
}: {
  parentId: string;
  runId: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { runs, loading, error, refresh } = useSubAgentRuns(parentId);
  const run = runs.find(
    (item) => item.runId === runId && item.parentConversationId === parentId,
  );
  if (run && !error)
    return (
      <>
        {run.outcome?.acceptance ? (
          <SubAgentAcceptanceDetails acceptance={run.outcome.acceptance} />
        ) : null}
        <SubAgentRunActions key={run.runId} run={run} />
      </>
    );
  return (
    <div className="tool-call-sub-agent-pending">
      {loading ? (
        <Loader2 size={13} className="tool-call-icon-spinning" />
      ) : (
        <AlertCircle size={13} />
      )}
      <span>
        {error ||
          t(loading ? "subAgentRun.loading" : "subAgentRun.unavailable")}
      </span>
      {!loading ? (
        <button
          type="button"
          className="tool-call-sub-agent-list-item-jump"
          onClick={() => void refresh()}
        >
          {t("subAgentRun.refresh")}
        </button>
      ) : null}
    </div>
  );
};

const ObservationRow = ({
  run,
  parentId,
}: {
  run: SubAgentRunObservation;
  parentId?: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [showDetails, setShowDetails] = useState(false);
  const title = run.title || run.agentName || t("subAgentRun.title");
  const canInspect =
    !!parentId &&
    (!run.parentConversationId || run.parentConversationId === parentId);
  return (
    <section
      className={`tool-call-sub-agent-observation tool-call-run-tone--${statusTone(run.status)}`}
    >
      <div className="tool-call-sub-agent-list-item">
        <div className="tool-call-run-identity">
          <span className="tool-call-run-icon">{statusIcon(run.status)}</span>
          <span className="tool-call-sub-agent-list-item-name" title={title}>
            {title}
          </span>
        </div>
        <div className="tool-call-run-meta">
          {run.executionMode ? (
            <span className="tool-call-run-mode">
              {t(`subAgentRun.mode.${run.executionMode}`)}
            </span>
          ) : null}
          <span className="tool-call-run-status">
            {t(`subAgentRun.status.${run.status}`)}
          </span>
          {run.acceptanceSatisfied !== undefined ? (
            <span
              className={`tool-call-sub-agent-acceptance-verdict ${run.acceptanceSatisfied ? "is-passed" : "is-unmet"}`}
            >
              {t(
                run.acceptanceSatisfied
                  ? "toolCall.subAgent.acceptance.verdictPassed"
                  : "toolCall.subAgent.acceptance.verdictUnmet",
              )}
            </span>
          ) : null}
          {canInspect ? (
            <button
              type="button"
              className="tool-call-sub-agent-list-item-jump"
              aria-expanded={showDetails}
              onClick={() => setShowDetails((open) => !open)}
            >
              <ChevronRight size={12} aria-hidden="true" />
              {t("subAgentTools.details")}
            </button>
          ) : null}
        </div>
      </div>
      {run.error ? (
        <div className="tool-call-error">
          <AlertCircle size={12} aria-hidden="true" />
          <span>{run.error}</span>
        </div>
      ) : null}
      {run.summary ? (
        <details className="tool-call-section">
          <summary className="tool-call-section-label">
            {t(run.paged ? "subAgentTools.paged" : "subAgentTools.summary")}
          </summary>
          <MarkdownBlock className="ai-message" content={run.summary} />
        </details>
      ) : null}
      {showDetails && canInspect && parentId ? (
        <PersistedRunDetails parentId={parentId} runId={run.runId} />
      ) : null}
    </section>
  );
};

/** Live reads are scoped and event-driven; they never acknowledge model delivery. */
const LiveWaitRuns = ({
  parentId,
  runIds,
  runs,
  loading,
  error,
}: {
  parentId: string;
  runIds: string[];
} & Pick<
  ReturnType<typeof useSubAgentRuns>,
  "runs" | "loading" | "error"
>): React.JSX.Element => {
  const { t } = useI18n();
  const selected = new Map(runs.map((run) => [run.runId, run]));
  return (
    <>
      {error ? (
        <div className="tool-call-error">
          <AlertCircle size={12} />
          <span>{error}</span>
        </div>
      ) : null}
      {runIds.map((runId) => {
        const record = selected.get(runId);
        const observed =
          record?.parentConversationId === parentId
            ? observeSubAgentRun(record)
            : null;
        return observed ? (
          <ObservationRow key={runId} run={observed} parentId={parentId} />
        ) : (
          <div
            key={runId}
            className="tool-call-sub-agent-pending"
            title={runId}
          >
            {loading ? (
              <Loader2 size={13} className="tool-call-icon-spinning" />
            ) : (
              <Bot size={13} />
            )}
            <span>
              {t(loading ? "subAgentRun.loading" : "subAgentRun.unavailable")}
            </span>
          </div>
        );
      })}
    </>
  );
};

/** Transport completion, observed run state and acceptance remain distinct. */
export const SubAgentRunToolCall = ({
  toolCall,
  conversationId,
}: {
  toolCall: ToolCallInfo;
  conversationId?: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { activeConversationId } = useChatConversationContext();
  const parentId = conversationId ?? activeConversationId;
  const parsed = useMemo(
    () => parseSubAgentObservationResult(toolCall.result),
    [toolCall.result],
  );
  const args = useMemo(
    () => readArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const runIds = useMemo(
    () =>
      Array.isArray(args.runIds)
        ? Array.from(
            new Set(
              args.runIds.filter(
                (id): id is string =>
                  typeof id === "string" && id.trim().length > 0,
              ),
            ),
          )
        : [],
    [args],
  );
  const resultValue = useMemo(
    () =>
      parsed.kind === "raw" && toolCall.result
        ? readResultValue(toolCall.result)
        : undefined,
    [parsed.kind, toolCall.result],
  );
  // Keep the subscription above lazyBody: folded headers must update too.
  // Only exact run identities from this parent may replace query snapshots.
  const live = useSubAgentRuns(parentId);
  const currentById = new Map(
    live.runs
      .filter((run) => run.parentConversationId === parentId)
      .map((run) => [run.runId, run]),
  );
  const runs =
    parsed.kind === "runs"
      ? parsed.runs.map((snapshot) => {
          const current = !live.error && currentById.get(snapshot.runId);
          const observed = current ? observeSubAgentRun(current) : null;
          if (
            !observed ||
            (snapshot.parentConversationId &&
              snapshot.parentConversationId !== parentId)
          )
            return snapshot;
          // A paged result remains a page; refreshing status must not silently replace it.
          return snapshot.paged
            ? { ...observed, summary: snapshot.summary, paged: true }
            : observed;
        })
      : [];
  const liveWait =
    parsed.kind === "empty" &&
    toolCall.name === "sub-agents-wait" &&
    toolCall.status === "running" &&
    !!parentId &&
    runIds.length > 0;
  const waitingRuns =
    liveWait && !live.error
      ? runIds.flatMap((id) => {
          const run = currentById.get(id);
          return run ? [run] : [];
        })
      : [];
  const visibleRuns = liveWait ? waitingRuns : runs;
  const totalCount = liveWait ? runIds.length : runs.length;
  const terminalCount = visibleRuns.filter((run) =>
    isSubAgentTerminal(run.status),
  ).length;
  // A completed wait request does not mean every run succeeded or passed acceptance.
  const headerTone =
    parsed.kind === "error" || toolCall.status === "error"
      ? "failed"
      : parsed.kind === "cancel"
        ? statusTone(parsed.receipt.runStatus)
        : visibleRuns.some((run) => statusTone(run.status) === "failed")
          ? "failed"
          : (parsed.kind === "runs" && parsed.timedOut) ||
              visibleRuns.some(
                (run) =>
                  run.status === "waiting_input" ||
                  run.status === "cancelled" ||
                  ("acceptanceSatisfied" in run &&
                    run.acceptanceSatisfied === false) ||
                  ("outcome" in run &&
                    run.outcome?.acceptanceSatisfied === false),
              )
            ? "attention"
            : totalCount > 0 && terminalCount === totalCount
              ? "completed"
              : toolCall.status === "running" ||
                  visibleRuns.some(
                    (run) => statusTone(run.status) === "running",
                  )
                ? "running"
                : "pending";
  const displayName =
    parsed.kind === "runs" || (liveWait && waitingRuns.length === runIds.length)
      ? t("subAgentTools.settledCount", {
          values: { count: terminalCount, total: totalCount },
        })
      : toolCall.name === "sub-agents-wait" && runIds.length > 0
        ? t(
            args.mode === "any"
              ? "subAgentTools.waitAny"
              : "subAgentTools.waitAll",
            { values: { count: runIds.length } },
          )
        : parsed.kind === "cancel"
          ? t(`subAgentRun.cancel.${parsed.receipt.disposition}`)
          : undefined;
  const allCurrent =
    !live.error &&
    runs.length > 0 &&
    runs.every(
      (run) =>
        currentById.has(run.runId) && run.parentConversationId === parentId,
    );
  return (
    <ToolCallNode
      toolName={toolCall.name}
      category="agent"
      className={`tool-call-sub-agent-run tool-call-run-tone--${headerTone}`}
      displayName={
        displayName ? (
          <span className="tool-call-run-progress">{displayName}</span>
        ) : undefined
      }
      displayNameTitle={
        parsed.kind === "runs"
          ? t(
              allCurrent
                ? "subAgentTools.currentState"
                : "subAgentTools.snapshotState",
            )
          : undefined
      }
      status={parsed.kind === "error" ? "error" : toolCall.status}
      defaultOpen={parsed.kind === "error" || toolCall.status === "running"}
      lazyBody
      meta={
        parsed.kind === "runs" && parsed.timedOut ? (
          <span className="tool-call-run-timeout">
            {t("subAgentTools.timedOut")}
          </span>
        ) : undefined
      }
    >
      <div className="tool-call-body tool-call-sub-agent-observations">
        {liveWait && parentId ? (
          <LiveWaitRuns parentId={parentId} runIds={runIds} {...live} />
        ) : parsed.kind === "empty" ? (
          <div className="tool-call-sub-agent-pending">
            <Bot size={13} aria-hidden="true" />
            <span>
              {t(
                toolCall.status === "running" || toolCall.status === "pending"
                  ? "subAgentRun.loading"
                  : "subAgentRun.unavailable",
              )}
            </span>
          </div>
        ) : null}
        {parsed.kind === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{localizeToolError(t, parsed.message)}</span>
          </div>
        ) : null}
        {runs.map((run) => (
          <ObservationRow key={run.runId} run={run} parentId={parentId} />
        ))}
        {parsed.kind === "cancel" ? (
          <div
            className={`tool-call-sub-agent-list-item tool-call-run-tone--${statusTone(parsed.receipt.runStatus)}`}
            role="status"
          >
            <span className="tool-call-run-icon">
              {statusIcon(parsed.receipt.runStatus)}
            </span>
            <span>{t(`subAgentRun.cancel.${parsed.receipt.disposition}`)}</span>
            <span className="tool-call-run-status">
              {t(`subAgentRun.status.${parsed.receipt.runStatus}`)}
            </span>
          </div>
        ) : null}
        {parsed.kind === "raw" ? <ToolResultView value={resultValue} /> : null}
      </div>
    </ToolCallNode>
  );
};
