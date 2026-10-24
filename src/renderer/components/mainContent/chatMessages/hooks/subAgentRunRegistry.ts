import type {
  SubAgentCancelReceipt,
  SubAgentCancellationSource,
  SubAgentResultPage,
  SubAgentRunCommand,
  SubAgentRunCommandResult,
  SubAgentRunRecord,
  SubAgentRunScope,
  SubAgentWaitResult,
} from "../../../../../shared/subAgentRuns";
import { isSubAgentTerminal } from "../../../../../shared/subAgentRuns";

/** The desktop host supplies the real IPC/storage implementation. */
export type SubAgentRunPersistence = {
  command(command: SubAgentRunCommand): Promise<SubAgentRunCommandResult>;
  onCommitted(run: SubAgentRunRecord): void;
};

type OwnedRun = {
  promise: Promise<string>;
  cancel: () => Promise<void>;
  stopPromise?: Promise<void>;
  finished: boolean;
  observer?: Promise<void>;
  error?: Error;
};

// Renderer-lifetime ownership, independent of the selected chat or React tree.
const ownedRuns = new Map<string, OwnedRun>();
const listeners = new Set<() => void>();

export const subscribeSubAgentRunChanges = (
  listener: () => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** I forwards durable IPC invalidation here as well as local owner changes. */
export const notifySubAgentRunChanges = (): void => {
  for (const listener of listeners) listener();
};

export const hasOwnedSubAgentRun = (runId: string): boolean => {
  const owner = ownedRuns.get(runId);
  return Boolean(owner && !owner.finished);
};

const requireOwner = (runId: string): OwnedRun => {
  const owner = ownedRuns.get(runId);
  if (!owner)
    throw new Error(
      `OWNER_MISMATCH: no local execution owner for run ${runId}`,
    );
  return owner;
};

/** Retained failures must remain inspectable even after the execution stopped. */
export const getOwnedSubAgentRunError = (runId: string): Error | undefined =>
  ownedRuns.get(runId)?.error;

export const awaitOwnedSubAgentRun = async (runId: string): Promise<void> => {
  await requireOwner(runId).promise;
};

export const cancelOwnedSubAgentRun = async (runId: string): Promise<void> => {
  const owner = requireOwner(runId);
  // Install before invoking cancellation so UI, invalidation and deletion
  // share one resource stop AND one execution drain. Retain rejections too.
  owner.stopPromise ??= Promise.allSettled([
    Promise.resolve().then(() => {
      if (!owner.finished) return owner.cancel();
    }),
    owner.promise,
  ]).then((results) => {
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length)
      throw new AggregateError(
        errors,
        `PERSISTENCE_ERROR: run ${runId} did not stop cleanly`,
      );
  });
  await owner.stopPromise;
};

/** Register BEFORE executing: even hydration/initialization failures have an owner. */
export const startOwnedSubAgentRun = (
  runId: string,
  execute: () => Promise<string>,
  cancel: () => Promise<void>,
): Promise<string> => {
  if (ownedRuns.has(runId))
    throw new Error(`RUN_BUSY: run ${runId} already has an owner`);
  const promise = Promise.resolve().then(execute);
  const owner: OwnedRun = { promise, cancel, finished: false };
  ownedRuns.set(runId, owner);
  // This rejection observer is owned by the registry. The original promise
  // still rejects for sync callers, wait-for-delete and cancellation callers.
  owner.observer = promise
    .then(
      () => {
        owner.finished = true;
        notifySubAgentRunChanges();
      },
      (error: unknown) => {
        owner.error = error instanceof Error ? error : new Error(String(error));
        owner.finished = true;
        console.error("[sub-agent-run] owner failed", {
          runId,
          code: "SUB_AGENT_OWNER_FAILED",
          phase: "execution_or_settlement",
        });
        notifySubAgentRunChanges();
      },
    )
    .catch((error: unknown) => {
      owner.error ??= error instanceof Error ? error : new Error(String(error));
      console.error("[sub-agent-run] observer failed", {
        runId,
        code: "SUB_AGENT_NOTIFICATION_FAILED",
        phase: "local_invalidation",
      });
    });
  return promise;
};

export const getOwnedSubAgentRunResult = (runId: string): Promise<string> =>
  requireOwner(runId).promise;

export const readSubAgentRunResult = async (
  persistence: SubAgentRunPersistence,
  scope: SubAgentRunScope,
  runId: string,
  offset?: number,
  limit?: number,
): Promise<SubAgentResultPage> => {
  const result = await persistence.command({
    op: "get",
    scope,
    runId,
    offset,
    limit,
  });
  if (result.kind !== "result")
    throw new Error("PERSISTENCE_ERROR: get returned an unexpected receipt");
  return result;
};

export const requestOwnedSubAgentRunCancel = async (
  persistence: SubAgentRunPersistence,
  scope: SubAgentRunScope,
  runId: string,
  source?: SubAgentCancellationSource,
): Promise<SubAgentCancelReceipt> => {
  const result = await persistence.command({
    op: "cancel",
    scope,
    runId,
    source,
  });
  if (result.kind !== "cancel")
    throw new Error("PERSISTENCE_ERROR: cancel returned an unexpected receipt");
  notifySubAgentRunChanges();
  if (
    (result.disposition === "requested" ||
      result.disposition === "confirmed") &&
    hasOwnedSubAgentRun(runId)
  ) {
    await cancelOwnedSubAgentRun(runId);
    const current = await readSubAgentRunResult(persistence, scope, runId);
    return {
      ...result,
      disposition:
        current.run.status === "cancelled" ? "confirmed" : result.disposition,
      runStatus: current.run.status,
      cancellation: current.run.cancellation,
    };
  }
  return result;
};

export const waitForSubAgentRuns = async (
  persistence: SubAgentRunPersistence,
  scope: SubAgentRunScope,
  runIds: string[],
  mode: "any" | "all" = "any",
  timeoutMs = 30000,
): Promise<SubAgentWaitResult> => {
  if (
    !runIds.length ||
    runIds.length > 32 ||
    new Set(runIds).size !== runIds.length ||
    runIds.some((id) => !id.trim())
  ) {
    throw new Error(
      "VALIDATION_ERROR: runIds must contain 1..32 unique non-empty IDs",
    );
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000) {
    throw new Error(
      "VALIDATION_ERROR: timeoutMs must be an integer in 0..120000",
    );
  }
  const deadline = Date.now() + timeoutMs;
  const readAll = () =>
    Promise.all(
      runIds.map((runId) => readSubAgentRunResult(persistence, scope, runId)),
    );
  // Validate the entire scope/ID set before early any-success or subscribing.
  let results = await readAll();
  let revision = 0;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = subscribeSubAgentRunChanges(() => {
    revision += 1;
    wake?.();
  });
  try {
    while (true) {
      const beforeRead = revision;
      // Check-subscribe-recheck closes the lost completion window.
      results = await readAll();
      const terminal = results.map((result) =>
        isSubAgentTerminal(result.run.status),
      );
      const satisfied =
        mode === "all" ? terminal.every(Boolean) : terminal.some(Boolean);
      if (satisfied || Date.now() >= deadline) {
        return {
          success: true,
          kind: "wait",
          timedOut: !satisfied,
          mode,
          results,
        };
      }
      if (revision !== beforeRead) continue;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        if (revision !== beforeRead) resolve();
      });
      wake = undefined;
      if (timer !== undefined) clearTimeout(timer);
    }
  } finally {
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
  }
};
