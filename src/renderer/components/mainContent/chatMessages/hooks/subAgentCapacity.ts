import type { SubAgentRunCommandResult } from "../../../../../shared/subAgentRuns";
import { subscribeSubAgentRunChanges } from "./subAgentRunRegistry";

type Transition = Extract<SubAgentRunCommandResult, { kind: "transition" }>;
/** Initial check, subscribe, recheck. Retries only follow durable invalidations or cancellation. */
export const waitForSubAgentCapacity = async (
  attempt: () => Promise<Transition>,
  isCancelled: () => boolean,
  signal: AbortSignal,
): Promise<Transition | undefined> => {
  if (isCancelled() || signal.aborted) return undefined;
  let result = await attempt();
  if (!result.waitingForCapacity) return result;
  let revision = 0;
  let wake: (() => void) | undefined;
  const changed = (): void => {
    revision += 1;
    wake?.();
  };
  const unsubscribe = subscribeSubAgentRunChanges(changed);
  const unsubscribeHost = window.snow.onSubAgentRunsChanged(changed);
  signal.addEventListener("abort", changed);
  try {
    while (!isCancelled() && !signal.aborted) {
      const before = revision;
      result = await attempt();
      if (!result.waitingForCapacity) return result;
      if (isCancelled() || signal.aborted) return undefined;
      if (revision !== before) continue;
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (revision !== before || isCancelled() || signal.aborted) resolve();
      });
      wake = undefined;
    }
    return undefined;
  } finally {
    unsubscribe();
    unsubscribeHost();
    signal.removeEventListener("abort", changed);
  }
};
