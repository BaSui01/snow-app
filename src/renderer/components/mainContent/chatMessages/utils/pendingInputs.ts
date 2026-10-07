import type {
  ConversationContextValue,
  PendingQueueItem,
} from "./conversationTypes";

/** Keep the visible queue scoped to its owning conversation. */
export const refreshPendingMessages = (
  ctx: ConversationContextValue,
  sessionKey: string,
): void => {
  if (ctx.activeSessionKeyRef.current === sessionKey) {
    ctx.setActivePendingMessages(
      (ctx.pendingQueueRef.current.get(sessionKey) ?? []).map(
        (item) => item.text,
      ),
    );
  }
};

export const hasPendingSteering = (
  ctx: ConversationContextValue,
  sessionKey: string,
): boolean => {
  const runId = ctx.sessionsRefData.current.get(sessionKey)?.runId;
  return (ctx.pendingQueueRef.current.get(sessionKey) ?? []).some(
    (item) =>
      item.options.deliveryMode === "steer" &&
      (item.steeringRunId === undefined || item.steeringRunId === runId),
  );
};

/** Call only at a settled tool/model boundary. Never consume follow-up tasks.
 * Selection is synchronous so withdrawals and new arrivals cannot race an await.
 * Steers for a replaced generation become ordinary follow-ups, not new steers. */
export const takePendingSteering = (
  ctx: ConversationContextValue,
  sessionKey: string,
): PendingQueueItem[] => {
  const ref = ctx.sessionsRefData.current.get(sessionKey);
  if (!ref?.isSending || ref.isAbortRequested) return [];
  const queue = ctx.pendingQueueRef.current.get(sessionKey) ?? [];
  const selected: PendingQueueItem[] = [];
  const remaining: PendingQueueItem[] = [];
  for (const item of queue) {
    if (item.options.deliveryMode !== "steer") {
      remaining.push(item);
    } else if (
      item.steeringRunId !== undefined &&
      item.steeringRunId !== ref.runId
    ) {
      remaining.push({
        ...item,
        options: { ...item.options, deliveryMode: "queue" },
        steeringRunId: undefined,
      });
    } else {
      selected.push(item);
    }
  }
  if (remaining.length) ctx.pendingQueueRef.current.set(sessionKey, remaining);
  else ctx.pendingQueueRef.current.delete(sessionKey);
  refreshPendingMessages(ctx, sessionKey);
  return selected;
};

/** A complete run consumes one follow-up, preserving its own options and FIFO. */
export const takeNextQueuedMessage = (
  ctx: ConversationContextValue,
  sessionKey: string,
): PendingQueueItem | undefined => {
  const queue = ctx.pendingQueueRef.current.get(sessionKey);
  const item = queue?.shift();
  if (queue && !queue.length) ctx.pendingQueueRef.current.delete(sessionKey);
  refreshPendingMessages(ctx, sessionKey);
  return item;
};

/** Once a run stops, unconsumed steers remain withdrawable as ordinary tasks. */
export const demotePendingSteering = (
  ctx: ConversationContextValue,
  sessionKey: string,
): void => {
  const queue = ctx.pendingQueueRef.current.get(sessionKey);
  if (!queue) return;
  for (const item of queue) {
    if (item.options.deliveryMode === "steer") {
      item.options = { ...item.options, deliveryMode: "queue" };
      item.steeringRunId = undefined;
    }
  }
  refreshPendingMessages(ctx, sessionKey);
};
