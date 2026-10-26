import type {
  SubAgentRunError,
  SubAgentRunRecord,
  SubAgentRunScope,
} from "../../../../../shared/subAgentRuns";
import { isSubAgentTerminal } from "../../../../../shared/subAgentRuns";
import type { SubAgentRunPersistence } from "./subAgentRunRegistry";
import {
  getOwnedSubAgentRunResult,
  hasOwnedSubAgentRun,
  readSubAgentRunResult,
  waitForSubAgentRuns,
} from "./subAgentRunRegistry";

import { getErrorMessage } from "../utils/conversationHelpers";

export { settledResult, awaitSettledSubAgentResult, runError, toolFailure };
const settledResult = (run: SubAgentRunRecord): string => {
  if (!isSubAgentTerminal(run.status) || !run.outcome)
    throw new Error("PERSISTENCE_ERROR: terminal run has no durable outcome");
  const outcome = run.outcome;
  const { snapshot: _snapshot, ...observed } = run;
  return JSON.stringify({
    success: true,
    kind: "result",
    run: observed,
    summaryPage: {
      text: outcome.summary,
      offset: 0,
      total: Array.from(outcome.summary).length,
      nextOffset: null,
    },
  });
};

/** Sync replays wait for the same durable run and return the current result envelope. */
const awaitSettledSubAgentResult = async (
  persistence: SubAgentRunPersistence,
  scope: SubAgentRunScope,
  runId: string,
): Promise<string> => {
  if (hasOwnedSubAgentRun(runId)) return getOwnedSubAgentRunResult(runId);
  let page = await readSubAgentRunResult(persistence, scope, runId, 0, 64000);
  while (!isSubAgentTerminal(page.run.status)) {
    page = (
      await waitForSubAgentRuns(persistence, scope, [runId], "all", 120000)
    ).results[0];
  }
  const run = page.run;
  if (!run.outcome)
    throw new Error("PERSISTENCE_ERROR: terminal run has no outcome");
  if (page.summaryPage) {
    let summary = page.summaryPage.text;
    while (page.summaryPage?.nextOffset != null) {
      page = await readSubAgentRunResult(
        persistence,
        scope,
        runId,
        page.summaryPage.nextOffset,
        64000,
      );
      if (!page.summaryPage)
        throw new Error("PERSISTENCE_ERROR: summary pagination disappeared");
      summary += page.summaryPage.text;
    }
    return settledResult({ ...run, outcome: { ...run.outcome, summary } });
  }
  return settledResult(run);
};
const runError = (
  category: SubAgentRunError["category"],
  code: string,
  error: unknown,
): SubAgentRunError => {
  const message = getErrorMessage(error);
  const prefix = message.match(
    /(?:^|\s)(VALIDATION_ERROR|CONFIGURATION_ERROR|PERMISSION_DENIED|RUN_NOT_FOUND|REQUEST_CONFLICT|RUN_BUSY|OWNER_MISMATCH|INVALID_TRANSITION|PERSISTENCE_ERROR|CONVERSATION_DELETING|DELETE_PENDING|UNSUPPORTED_EXECUTION_MODE)(?=:)/,
  )?.[1];
  if (prefix === "PERSISTENCE_ERROR") category = "persistence";
  else if (prefix === "CONFIGURATION_ERROR") category = "configuration";
  else if (prefix === "PERMISSION_DENIED" || prefix === "OWNER_MISMATCH")
    category = "permission";
  return { category, code: prefix ?? code, message, retryable: false };
};
const toolFailure = (error: unknown): string => {
  const failure = runError("validation", "SUB_AGENT_EXECUTION_FAILED", error);
  return JSON.stringify({
    success: false,
    error: failure.message,
    code: failure.code,
    category: failure.category,
  });
};
