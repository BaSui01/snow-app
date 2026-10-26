import { useMemo, useState } from "react";
import "../../../../themes/tool-cards.css";
import {
  AlertCircle,
  Ban,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDot,
} from "lucide-react";
import type {
  SubAgentResultPage,
  SubAgentRunStatus,
} from "../../../../../shared/subAgentRuns";
import {
  isSubAgentTerminal,
  SUB_AGENT_EVENT_CALL_PREFIX,
} from "../../../../../shared/subAgentRuns";
import { useI18n } from "../../../../i18n";
import { useChatConversationContext } from "../components/ChatConversationContext";
import { MarkdownBlock } from "../components/markdownRenderer";
import {
  useSubAgentRunResult,
  useSubAgentRuns,
} from "../hooks/subAgentRuntimeClient";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { SubAgentRunActions } from "./SubAgentToolCall";
import { SubAgentAcceptanceDetails } from "../components/SubAgentRunDetails";
import { ToolCallNode } from "./shared/ToolCallNode";
import { ToolResultView } from "./shared/ToolResultView";
import { localizeToolError } from "./shared/toolErrorDisplay";
import {
  observeSubAgentRun,
  parseSubAgentObservationResult,
  parseSubAgentResultRequest,
  subAgentRunTone,
  type SubAgentRunObservation,
} from "./subAgentRunObservation";

const readResultValue = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};
const statusTone = subAgentRunTone;
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
  if (status !== "queued") return <CircleDot size={13} aria-hidden="true" />;
  return <Bot size={13} aria-hidden="true" />;
};
type RunQuery = ReturnType<typeof useSubAgentRuns>;
type RunRecord = RunQuery["runs"][number];

const ObservationRow = ({
  run,
  parentId,
  current,
  readOnly = false,
}: {
  run: SubAgentRunObservation;
  parentId?: string;
  current?: RunRecord;
  readOnly?: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { handleSelectConversation } = useChatConversationContext();
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
          {run.agentName && run.agentName !== title ? (
            <span className="tool-call-run-agent">{run.agentName}</span>
          ) : null}
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
          {canInspect && (readOnly ? !!run.conversationId : !!current) ? (
            <button
              type="button"
              className="tool-call-sub-agent-list-item-jump"
              aria-expanded={readOnly ? undefined : showDetails}
              onClick={() => {
                if (readOnly && run.conversationId)
                  void handleSelectConversation(run.conversationId);
                else setShowDetails((open) => !open);
              }}
            >
              <ChevronRight size={12} aria-hidden="true" />
              {t(
                readOnly
                  ? "toolCall.subAgent.jumpToConversation"
                  : "subAgentTools.details",
              )}
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
      {run.acceptance && (readOnly || !current) ? (
        <details className="tool-call-section">
          <summary className="tool-call-section-label">
            {t("toolCall.subAgent.acceptance.title")}
            <span className="tool-call-sub-agent-acceptance-count">
              {t("toolCall.subAgent.acceptance.count", {
                values: {
                  completed: run.acceptance.counts.completed,
                  total: run.acceptance.counts.total,
                },
              })}
            </span>
          </summary>
          <SubAgentAcceptanceDetails acceptance={run.acceptance} />
        </details>
      ) : null}
      {showDetails && canInspect && !readOnly && current ? (
        <>
          {current.outcome?.acceptance ? (
            <SubAgentAcceptanceDetails
              acceptance={current.outcome.acceptance}
            />
          ) : null}
          <SubAgentRunActions key={current.runId} run={current} />
        </>
      ) : null}
    </section>
  );
};

type RunToolCallProps = { toolCall: ToolCallInfo; conversationId?: string };

export const SubAgentRunToolCall = (
  props: RunToolCallProps,
): React.JSX.Element =>
  props.toolCall.name === "sub-agents-getResult" ? (
    <ResultRunToolCall {...props} />
  ) : (
    <CurrentRunToolCall {...props} />
  );

const ResultRunToolCall = (props: RunToolCallProps): React.JSX.Element => {
  const { activeConversationId } = useChatConversationContext();
  const request = useMemo(
    () => parseSubAgentResultRequest(props.toolCall.arguments),
    [props.toolCall.arguments],
  );
  const pending =
    props.toolCall.status === "pending" || props.toolCall.status === "running";
  const live = useSubAgentRunResult(
    pending ? undefined : (props.conversationId ?? activeConversationId),
    request,
  );
  return (
    <SubAgentRunToolCallView {...props} live={live} resultRequest={request} />
  );
};

const CurrentRunToolCall = (props: RunToolCallProps): React.JSX.Element => {
  const { activeConversationId } = useChatConversationContext();
  const live = useSubAgentRuns(props.conversationId ?? activeConversationId);
  return <SubAgentRunToolCallView {...props} live={live} />;
};

const resultQueryErrorKey = (error: string): string => {
  if (/\bRUN_NOT_FOUND\b/.test(error)) return "subAgentTools.runNotFound";
  if (/\b(?:PERMISSION_DENIED|SCOPE_DENIED)\b/.test(error))
    return "subAgentTools.scopeDenied";
  if (/\bRESULT_NOT_READY\b/.test(error)) return "subAgentTools.notTerminal";
  return "subAgentTools.queryFailed";
};

/** Transport completion, observed run state and acceptance remain distinct. */
const SubAgentRunToolCallView = ({
  toolCall,
  conversationId,
  live,
  resultRequest,
}: RunToolCallProps & {
  live?: RunQuery & { result?: SubAgentResultPage };
  resultRequest?: ReturnType<typeof parseSubAgentResultRequest>;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { activeConversationId } = useChatConversationContext();
  const parentId = conversationId ?? activeConversationId;
  const resultLookup = toolCall.name === "sub-agents-getResult";
  const syntheticDelivery =
    toolCall.callId?.startsWith(SUB_AGENT_EVENT_CALL_PREFIX) ?? false;
  const awaitingToolResult =
    !toolCall.result?.trim() &&
    (toolCall.status === "pending" || toolCall.status === "running");
  const source = useMemo(
    () => parseSubAgentObservationResult(toolCall.result),
    [toolCall.result],
  );
  const recovered = useMemo(
    () =>
      live?.result
        ? parseSubAgentObservationResult(JSON.stringify(live.result))
        : undefined,
    [live?.result],
  );
  const parsed =
    source.kind === "empty" && !awaitingToolResult && recovered?.kind === "runs"
      ? recovered
      : source;
  const resultValue = useMemo(
    () =>
      parsed.kind === "raw" && toolCall.result
        ? readResultValue(toolCall.result)
        : undefined,
    [parsed.kind, toolCall.result],
  );
  const currentById = new Map(
    live?.runs
      .filter((run) => run.parentConversationId === parentId)
      .map((run) => [run.runId, run]),
  );
  const snapshots =
    parsed.kind === "runs"
      ? parsed.runs.filter(
          (run) =>
            !resultLookup ||
            (run.runId === resultRequest?.runId &&
              (!run.parentConversationId ||
                run.parentConversationId === parentId)),
        )
      : [];
  const runs = snapshots.map((snapshot) => {
    if (
      snapshot.parentConversationId &&
      snapshot.parentConversationId !== parentId
    )
      return snapshot;
    const current = currentById.get(snapshot.runId);
    const observed = resultLookup
      ? recovered?.kind === "runs"
        ? recovered.runs.find((run) => run.runId === snapshot.runId)
        : null
      : current
        ? observeSubAgentRun(current)
        : null;
    if (!observed) return snapshot;
    // A paged result remains a page while a refresh retains the last known facts.
    return snapshot.paged
      ? { ...observed, summary: snapshot.summary, paged: true }
      : observed;
  });
  const terminalCount = runs.filter((run) =>
    isSubAgentTerminal(run.status),
  ).length;
  const headerTone =
    parsed.kind === "error" || toolCall.status === "error"
      ? "failed"
      : parsed.kind === "cancel"
        ? statusTone(parsed.receipt.runStatus)
        : runs.some((run) => statusTone(run.status) === "failed")
          ? "failed"
          : runs.some(
                (run) =>
                  run.status === "waiting_input" ||
                  run.status === "cancelled" ||
                  run.acceptanceSatisfied === false,
              )
            ? "attention"
            : runs.length > 0 && terminalCount === runs.length
              ? "completed"
              : runs.some((run) => statusTone(run.status) === "running")
                ? "running"
                : "pending";
  const displayName =
    parsed.kind === "runs"
      ? t("subAgentTools.settledCount", {
          values: { count: terminalCount, total: runs.length },
        })
      : parsed.kind === "cancel"
        ? t(`subAgentRun.cancel.${parsed.receipt.disposition}`)
        : undefined;
  const allCurrent =
    !live?.error &&
    runs.length > 0 &&
    runs.every(
      (run) =>
        currentById.has(run.runId) &&
        (!run.parentConversationId || run.parentConversationId === parentId),
    );
  const missingCurrent = snapshots.some(
    (snapshot) =>
      !currentById.has(snapshot.runId) &&
      (!snapshot.parentConversationId ||
        snapshot.parentConversationId === parentId),
  );
  const queryStatus = (() => {
    if (awaitingToolResult) return "subAgentTools.awaitingResult";
    if (!live) return null;
    if (resultLookup) {
      if (!resultRequest) return "subAgentTools.queryFailed";
      if (!parentId) return "subAgentTools.scopeDenied";
      if (live.error) return resultQueryErrorKey(live.error);
      if (live.loading && runs.length === 0) return "subAgentRun.loading";
      if (runs.length === 0 && parsed.kind !== "error")
        return "subAgentTools.queryFailed";
      return null;
    }
    if (snapshots.length === 0 && parsed.kind !== "empty") return null;
    if (live.error) return "subAgentRun.queryFailed";
    if (missingCurrent || parsed.kind === "empty")
      return live.loading ? "subAgentRun.loading" : "subAgentRun.unavailable";
    return null;
  })();
  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={
        syntheticDelivery ? t("subAgentTools.resultDelivered") : undefined
      }
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
      status={toolCall.status}
      activityIndicator="single"
      defaultOpen={parsed.kind === "error" || toolCall.status === "running"}
      lazyBody
    >
      <div className="tool-call-body tool-call-sub-agent-observations">
        {queryStatus ? (
          <div className="tool-call-sub-agent-pending" role="status">
            {live?.error ? <AlertCircle size={12} aria-hidden="true" /> : null}
            <span>{t(queryStatus)}</span>
            {live &&
            !live.loading &&
            !awaitingToolResult &&
            (!resultLookup || (!!parentId && !!resultRequest)) ? (
              <button
                type="button"
                className="tool-call-sub-agent-list-item-jump"
                onClick={() => void live.refresh()}
              >
                {t("subAgentRun.refresh")}
              </button>
            ) : null}
          </div>
        ) : null}
        {parsed.kind === "error" && (!resultLookup || !queryStatus) ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>
              {resultLookup
                ? t(resultQueryErrorKey(parsed.message))
                : localizeToolError(t, parsed.message)}
            </span>
          </div>
        ) : null}
        {runs.map((run) => (
          <ObservationRow
            key={run.runId}
            run={run}
            parentId={parentId}
            readOnly={resultLookup}
            current={live?.error ? undefined : currentById.get(run.runId)}
          />
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
