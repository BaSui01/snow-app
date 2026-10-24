import type {
  SubAgentCancelReceipt,
  SubAgentRunStatus,
} from "../../../../../shared/subAgentRuns";

export type SubAgentRunObservation = {
  runId: string;
  conversationId?: string;
  parentConversationId?: string;
  title: string;
  agentName?: string;
  executionMode?: "sync" | "async";
  status: SubAgentRunStatus;
  summary?: string;
  error?: string;
  acceptanceSatisfied?: boolean;
  paged: boolean;
};

export const observeSubAgentRun = (
  run: unknown,
): SubAgentRunObservation | null => parseRun({ run });

export type SubAgentObservationResult =
  | { kind: "empty" }
  | { kind: "raw" }
  | { kind: "error"; message: string }
  | { kind: "cancel"; receipt: SubAgentCancelReceipt }
  | {
      kind: "runs";
      runs: SubAgentRunObservation[];
      timedOut: boolean;
    };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const statuses = new Set<string>([
  "queued",
  "running",
  "waiting_input",
  "finalizing",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const runStatus = (value: unknown): value is SubAgentRunStatus =>
  typeof value === "string" && statuses.has(value);

const parseRun = (page: unknown): SubAgentRunObservation | null => {
  if (!record(page)) return null;
  // Automatic delivery contains an outcome directly; explicit get/wait
  // returns a run record. Both are observations, never new authorization.
  const run = record(page.run) ? page.run : undefined;
  const outcome = record(run?.outcome)
    ? run.outcome
    : record(page.outcome)
      ? page.outcome
      : undefined;
  const runId = text(run?.runId) ?? text(outcome?.runId) ?? text(page.runId);
  const status = run?.status ?? outcome?.terminalStatus;
  if (!runId?.trim() || !runStatus(status)) return null;
  if (outcome?.runId !== undefined && outcome.runId !== runId) return null;
  if (
    outcome?.terminalStatus !== undefined &&
    outcome.terminalStatus !== status
  )
    return null;
  const summaryPage = record(page.summaryPage) ? page.summaryPage : undefined;
  const error = record(outcome?.error) ? outcome.error : undefined;
  const acceptance = record(outcome?.acceptance)
    ? outcome.acceptance
    : undefined;
  return {
    runId,
    conversationId: text(run?.conversationId) ?? text(outcome?.conversationId),
    parentConversationId:
      text(run?.parentConversationId) ?? text(outcome?.parentConversationId),
    title: text(run?.summary) ?? text(run?.agentName) ?? "",
    agentName: text(run?.agentName),
    executionMode:
      run?.executionMode === "sync" || run?.executionMode === "async"
        ? run.executionMode
        : undefined,
    status,
    summary: text(summaryPage?.text) ?? text(outcome?.summary),
    error: text(error?.message),
    acceptanceSatisfied:
      typeof outcome?.acceptanceSatisfied === "boolean"
        ? outcome.acceptanceSatisfied
        : typeof acceptance?.satisfied === "boolean"
          ? acceptance.satisfied
          : undefined,
    paged:
      typeof summaryPage?.nextOffset === "number" ||
      (typeof summaryPage?.offset === "number" && summaryPage.offset > 0),
  };
};

/** Parse only supported host envelopes; unknown payloads remain available raw. */
export const parseSubAgentObservationResult = (
  raw?: string,
): SubAgentObservationResult => {
  if (!raw?.trim()) return { kind: "empty" };
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value)) return { kind: "raw" };
    if (typeof value.error === "string")
      return { kind: "error", message: value.error };
    if (record(value.error) && typeof value.error.message === "string")
      return { kind: "error", message: value.error.message };
    if (value.kind === "cancel") {
      const dispositions = [
        "requested",
        "confirmed",
        "already_terminal",
        "too_late",
      ];
      if (
        value.success === true &&
        typeof value.runId === "string" &&
        value.runId.trim() &&
        typeof value.disposition === "string" &&
        dispositions.includes(value.disposition) &&
        runStatus(value.runStatus)
      ) {
        return {
          kind: "cancel",
          receipt: {
            success: true,
            kind: "cancel",
            runId: value.runId,
            disposition:
              value.disposition as SubAgentCancelReceipt["disposition"],
            runStatus: value.runStatus,
          },
        };
      }
      return { kind: "raw" };
    }
    if (value.kind === "wait" && Array.isArray(value.results)) {
      const runs = value.results.map(parseRun);
      if (value.success !== true || runs.some((run) => run === null))
        return { kind: "raw" };
      return {
        kind: "runs",
        runs: runs.filter((run): run is SubAgentRunObservation => run !== null),
        timedOut: value.timedOut === true,
      };
    }
    if (
      (value.kind === "result" && value.success === true) ||
      value.untrustedSubAgentResult === true
    ) {
      const run = parseRun(value);
      if (run) return { kind: "runs", runs: [run], timedOut: false };
    }
    return { kind: "raw" };
  } catch {
    return { kind: "raw" };
  }
};
