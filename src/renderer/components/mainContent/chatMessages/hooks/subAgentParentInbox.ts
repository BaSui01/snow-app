import {
  currentAgentTask,
  startAgentTask,
  finishAgentTask,
} from "./taskHistory";
import { useEffect, useRef } from "react";
import type { ChatInputSendOptions } from "../../chatInput/types";
import type {
  ChatConversationMessage,
  ConversationContextValue,
} from "../utils/conversationTypes";
import type {
  SubAgentEvent,
  SubAgentRunRecord,
  SubAgentRunScope,
} from "../../../../../shared/subAgentRuns";
import {
  isSubAgentTerminal,
  SUB_AGENT_EVENT_CALL_PREFIX,
} from "../../../../../shared/subAgentRuns";
import type { ChatMessageRecord } from "../../../../../preload";
import { createSubAgentMainToolExecutor } from "./subAgentActivation";
import type { SubAgentActivationDeps } from "./subAgentActivation";
import {
  drainOwnedSubAgentRun,
  cancelOwnedSubAgentRun,
  hasOwnedSubAgentRun,
  notifySubAgentRunChanges,
  requestOwnedSubAgentRunCancel,
  type SubAgentRunPersistence,
} from "./subAgentRunRegistry";
import {
  resolveSubAgentRunScope,
  setSubAgentRunActionResolver,
} from "./subAgentRuntimeClient";
import {
  buildConversationMessages,
  createMessageId,
  formatMessageTime,
} from "../utils/conversationHelpers";
import {
  markSubAgentInternalInput,
  SUB_AGENT_RESULT_CONTINUATION,
} from "../utils/subAgentInternalInput";

type ParentGroup = {
  parentId: string;
  taskId: string;
  state: "open" | "stopped" | "closed";
  scope?: SubAgentRunScope;
  ready: Promise<void>;
  waking: boolean;
  wakeAgain?: boolean;
  options?: ChatInputSendOptions;
};
const groups = new Map<string, ParentGroup>();
const durableChildren = new Map<string, string>();
export const isDurableSubAgentConversation = (
  conversationId: string,
): boolean => durableChildren.has(conversationId);
let runtime:
  | {
      getCtx(): ConversationContextValue;
      deps(): Pick<SubAgentActivationDeps, "requestToolAuthorizations">;
    }
  | undefined;
const command = windowCommand;
function windowCommand(
  request: Parameters<SubAgentRunPersistence["command"]>[0],
) {
  return window.snow.subAgentRunCommand(request);
}

export const reportSubAgentParentError = (
  ctx: ConversationContextValue,
  parentId: string,
  error: unknown,
): void => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[sub-agent-inbox]", {
    parentConversationId: parentId,
    code: "SUB_AGENT_PARENT_FAILED",
  });
  ctx.updateSessionMessages(parentId, (messages) => [
    ...messages,
    {
      id: createMessageId("assistant"),
      role: "assistant",
      content: `Sub-agent coordination failed; results are retained for explicit inspection. ${message}`,
      timestamp: formatMessageTime(),
      status: "error",
    },
  ]);
};

export const beginSubAgentParentTask = (
  parentId: string,
  taskId: string,
  options?: ChatInputSendOptions,
): void => {
  const previous = groups.get(parentId);
  if (previous?.taskId === taskId && previous.state === "open") return;
  const previousClosed = previous?.state === "closed";
  if (previous && !previousClosed) previous.state = "stopped";
  const group: ParentGroup = {
    parentId,
    taskId,
    state: "open",
    waking: false,
    options,
    ready: Promise.resolve(),
  };
  group.ready = previous
    ? previous.ready
        // A new explicit task is a fresh admission, not a retry of the failed
        // predecessor. Wait for its writes to settle, then recheck storage gates.
        .catch(() => undefined)
        .then(async () => {
          if (previous.scope && !previousClosed)
            await command({
              op: "parent_task",
              scope: previous.scope,
              parentTaskId: previous.taskId,
              state: "stopped",
            });
        })
    : Promise.resolve();
  groups.set(parentId, group);
  // Observe immediately without replacing the rejecting barrier awaited by dispatch.
  const supersededTaskId = previous?.taskId;
  void group.ready.catch((error: unknown) => {
    console.error("[sub-agent-inbox] parent task barrier failed", {
      parentConversationId: parentId,
      parentTaskId: taskId,
      supersededTaskId,
      code: "PERSISTENCE_ERROR",
    });
    const ctx = runtime?.getCtx();
    if (ctx)
      reportSubAgentParentError(
        ctx,
        parentId,
        new Error(
          `PERSISTENCE_ERROR: parent task ${taskId} could not close superseded task ${supersededTaskId ?? "none"}. ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  });
};
export const migrateSubAgentParentTask = (
  oldId: string,
  newId: string,
): void => {
  if (oldId === newId) return;
  const group = groups.get(oldId);
  if (group) {
    groups.delete(oldId);
    group.parentId = newId;
    groups.set(newId, group);
  }
};
/** Revoke only this renderer's parent wake eligibility; persisted results and child owners stay intact. */
export const revokeSubAgentParentOwnership = (parentId: string): void => {
  const group = groups.get(parentId);
  if (group) {
    group.state = "closed";
    group.wakeAgain = false;
  }
};
export const getSubAgentParentTaskId = (
  parentId: string,
): string | undefined => {
  const group = groups.get(parentId);
  return group?.state === "open" ? group.taskId : undefined;
};
const ensureGroup = async (
  scope: SubAgentRunScope,
  fallbackTaskId: string,
): Promise<ParentGroup> => {
  let group = groups.get(scope.parentConversationId);
  if (!group) {
    beginSubAgentParentTask(scope.parentConversationId, fallbackTaskId);
    group = groups.get(scope.parentConversationId)!;
  }
  if (group.state !== "open" || group.taskId !== fallbackTaskId)
    throw new Error(
      "INVALID_TRANSITION: dispatch belongs to a stopped or superseded parent task",
    );
  await group.ready;
  if (group.state !== "open" || groups.get(group.parentId) !== group)
    throw new Error("INVALID_TRANSITION: original parent task is not open");
  if (!group.scope) {
    group.scope = scope;
    group.ready = command({
      op: "parent_task",
      scope,
      parentTaskId: group.taskId,
      state: "open",
    }).then(() => undefined);
    await group.ready;
  }
  return group;
};
export const createSubAgentRunPersistence = (
  ctx: ConversationContextValue,
  capturedParentTaskId?: string,
): SubAgentRunPersistence => ({
  async command(request) {
    if (request.op === "accept") {
      const taskId = capturedParentTaskId ?? request.parentTaskId;
      const group = await ensureGroup(request.scope, taskId);
      if (
        groups.get(request.scope.parentConversationId) !== group ||
        group.state !== "open" ||
        group.taskId !== taskId
      ) {
        throw new Error(
          "INVALID_TRANSITION: dispatch belongs to a stopped or superseded parent task",
        );
      }
      const result = await command({ ...request, parentTaskId: taskId });
      if (result.kind === "accepted" && result.created) {
        // Track only committed local admissions, not failed dispatch attempts.
        ownerScopes.set(result.runId, request.scope);
        durableChildren.set(result.conversationId, result.runId);
      }
      return result;
    }
    return command(request);
  },
  onCommitted(run) {
    if (isSubAgentTerminal(run.status)) ownerScopes.delete(run.runId);
    notifySubAgentRunChanges();
    scheduleSubAgentParent(run.parentConversationId, ctx);
  },
});
const listRuns = async (
  scope: SubAgentRunScope,
): Promise<SubAgentRunRecord[]> => {
  const runs: SubAgentRunRecord[] = [];
  for (let offset = 0; ;) {
    const response = await command({ op: "list", scope, offset, limit: 100 });
    if (response.kind !== "runs")
      throw new Error("PERSISTENCE_ERROR: invalid run list");
    runs.push(...response.runs);
    offset += response.runs.length;
    if (offset >= response.total) return runs;
    if (!response.runs.length)
      throw new Error("PERSISTENCE_ERROR: incomplete run page");
  }
};
const pendingEvents = async (group: ParentGroup): Promise<SubAgentEvent[]> => {
  if (!group.scope) return [];
  const result = await command({
    op: "events",
    scope: group.scope,
    parentTaskId: group.taskId,
    includeReceived: true,
    limit: 100,
  });
  if (result.kind !== "events")
    throw new Error("PERSISTENCE_ERROR: invalid inbox response");
  return result.events;
};
const mergePairedMessages = (
  ctx: ConversationContextValue,
  parentId: string,
  records: ChatMessageRecord[],
  ids: ReadonlySet<string>,
): void => {
  // Reuse the history replay pairing so synthetic automatic receive pairs settle
  // in place; parseToolCalls alone would leave the getResult call pending.
  const received = new Map(
    buildConversationMessages(records)
      .filter((message) => ids.has(message.id))
      .map((message) => [message.id, message] as const),
  );
  ctx.updateSessionMessages(parentId, (previous) => {
    const previousIds = new Set(previous.map((message) => message.id));
    const updated = previous.map((message) => {
      const next = received.get(message.id);
      return next ? { ...message, ...next } : message;
    });
    const appended = [...received.values()].filter(
      (message) => !previousIds.has(message.id),
    );
    return appended.length ? [...updated, ...appended] : updated;
  });
};
const addReceivedMessages = async (
  ctx: ConversationContextValue,
  parentId: string,
  ids: string[],
  assertCurrent?: () => void,
): Promise<void> => {
  assertCurrent?.();
  if (!ids.length) return;
  const records = await window.snow.listChatMessages(parentId);
  assertCurrent?.();
  const selected = records.filter((record) => ids.includes(record.id));
  if (selected.length !== ids.length)
    throw new Error("PERSISTENCE_ERROR: committed parent input is missing");
  mergePairedMessages(ctx, parentId, records, new Set(ids));
};
/** Presentation-only repair for synthetic result cards left pending in memory. */
const isPendingSyntheticResult = (message: ChatConversationMessage): boolean =>
  message.role === "assistant" &&
  !!message.toolCalls?.some(
    (toolCall) =>
      toolCall.callId?.startsWith(SUB_AGENT_EVENT_CALL_PREFIX) &&
      !toolCall.result &&
      (toolCall.status === "pending" || toolCall.status === "running"),
  );
const reconcileSubAgentSyntheticResults = async (
  ctx: ConversationContextValue,
  parentId: string,
): Promise<void> => {
  const messages = ctx.sessionsRef.current[parentId]?.messages ?? [];
  const ids = new Set(
    messages.filter(isPendingSyntheticResult).map((message) => message.id),
  );
  if (!ids.size) return;
  const records = await window.snow.listChatMessages(parentId);
  mergePairedMessages(ctx, parentId, records, ids);
};
const receiveEvents = async (
  ctx: ConversationContextValue,
  group: ParentGroup,
  events: SubAgentEvent[],
  toolMessageId?: string,
  assertCurrent?: () => void,
): Promise<void> => {
  assertCurrent?.();
  if (!events.length || !group.scope || group.state !== "open") return;
  const response = await command({
    op: "receive",
    scope: group.scope,
    parentTaskId: group.taskId,
    eventIds: events.map((event) => event.eventId),
    toolMessageId,
  });
  assertCurrent?.();
  if (response.kind !== "received")
    throw new Error("PERSISTENCE_ERROR: invalid inbox acknowledgment");
  if (!toolMessageId) {
    await addReceivedMessages(
      ctx,
      group.parentId,
      response.messageIds,
      assertCurrent,
    );
    assertCurrent?.();
  }
};
/** Confirm only after the original parent loop has accepted these inputs. */
export const acknowledgeSubAgentParentWake = async (
  parentId: string,
  parentTaskId: string,
  eventIds: string[] = [],
  assertCurrent?: () => void,
): Promise<void> => {
  assertCurrent?.();
  if (!eventIds.length) return;
  const group = groups.get(parentId);
  if (!group || group.state !== "open" || group.taskId !== parentTaskId)
    throw new Error("INVALID_TRANSITION: original parent task is not open");
  await group.ready;
  assertCurrent?.();
  if (!group.scope || group.state !== "open" || groups.get(parentId) !== group)
    throw new Error("INVALID_TRANSITION: original parent task lost ownership");
  const result = await command({
    op: "acknowledge_wake",
    scope: group.scope,
    parentTaskId,
    eventIds,
  });
  assertCurrent?.();
  if (result.kind !== "wake_acknowledged")
    throw new Error("PERSISTENCE_ERROR: invalid wake acknowledgment");
};
const observedEvents = (content: string): Set<string> => {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.runId === "string" && typeof record.eventId === "string")
      ids.add(record.eventId);
    Object.values(record).forEach(visit);
  };
  for (const segment of content.split(/\n\n(?=\[Tool: )/u)) {
    const match =
      /^\[Tool: sub-agents-(?:activate|continue|getResult)#[^\n]+\]\n([\s\S]*)$/u.exec(
        segment,
      );
    if (!match) continue;
    try {
      const json = match[1].split(/\n\n\[Hook (?:Context|Warnings)\]\n/u, 1)[0];
      visit(JSON.parse(json));
    } catch {
      /* Not a result observation. */
    }
  }
  return ids;
};
/** Only call after every in-flight tool result has settled. Persist the original pair before inserting internal pairs. */
export const flushSubAgentToolBoundary = async (
  ctx: ConversationContextValue,
  parentId: string,
  content: string,
  owner: { parentTaskId: string; runId: number; owns: () => boolean },
): Promise<boolean> => {
  const group = groups.get(parentId);
  const assertCurrent = (): void => {
    const ref = ctx.sessionsRefData.current.get(parentId);
    if (
      !owner.owns() ||
      ref?.runId !== owner.runId ||
      !ref.isSending ||
      ref.isAbortRequested ||
      !group ||
      groups.get(parentId) !== group ||
      group.state !== "open" ||
      group.taskId !== owner.parentTaskId
    )
      throw new Error("INVALID_TRANSITION: stale parent tool boundary owner");
  };
  assertCurrent();
  if (!group?.scope) return false;
  await group.ready;
  assertCurrent();
  const events = await pendingEvents(group);
  assertCurrent();
  if (!events.length) return false;
  const records = await window.snow.listChatMessages(parentId);
  assertCurrent();
  const before = new Set(records.map((message) => message.id));
  await window.snow.appendToolMessage(parentId, content);
  assertCurrent();
  const committed = await window.snow.listChatMessages(parentId);
  assertCurrent();
  const stored = committed.findLast(
    (message) => message.role === "tool" && !before.has(message.id),
  );
  if (!stored)
    throw new Error("PERSISTENCE_ERROR: tool boundary was not persisted");
  const observed = observedEvents(content);
  await receiveEvents(
    ctx,
    group,
    events.filter((event) => observed.has(event.eventId)),
    stored.id,
    assertCurrent,
  );
  assertCurrent();
  await receiveEvents(
    ctx,
    group,
    events.filter((event) => !observed.has(event.eventId)),
    undefined,
    assertCurrent,
  );
  assertCurrent();
  // Confirm only the event batch captured by this exact task/run generation.
  await acknowledgeSubAgentParentWake(
    parentId,
    owner.parentTaskId,
    events.map((event) => event.eventId),
    assertCurrent,
  );
  assertCurrent();
  return true;
};
export const closeSubAgentParentIfIdle = async (
  parentId: string,
  parentTaskId: string,
): Promise<void> => {
  const group = groups.get(parentId);
  if (!group || group.state !== "open" || group.taskId !== parentTaskId) return;
  await group.ready;
  if (groups.get(parentId) !== group || group.state !== "open") return;
  if (!group.scope) {
    group.state = "closed";
    return;
  }
  const receipt = await command({
    op: "close_if_idle",
    scope: group.scope,
    parentTaskId,
  });
  if (receipt.kind !== "parent_idle")
    throw new Error("PERSISTENCE_ERROR: invalid idle receipt");
  if (
    receipt.closed &&
    groups.get(parentId) === group &&
    group.taskId === parentTaskId &&
    group.state === "open"
  )
    group.state = "closed";
};

export const scheduleSubAgentParent = (
  parentId: string,
  fallbackCtx?: ConversationContextValue,
): void => {
  const group = groups.get(parentId);
  const ctx = runtime?.getCtx() ?? fallbackCtx;
  if (
    !ctx ||
    !group ||
    group.state !== "open" ||
    ctx.sessionsRefData.current.get(parentId)?.isSending
  )
    return;
  if (group.waking) {
    group.wakeAgain = true;
    return;
  }
  group.waking = true;
  group.wakeAgain = false;
  const wake = async (): Promise<void> => {
    await group.ready;
    const events = await pendingEvents(group);
    if (
      !events.length ||
      group.state !== "open" ||
      groups.get(parentId) !== group ||
      ctx.sessionsRefData.current.get(parentId)?.isSending ||
      ctx.pendingQueueRef.current.get(parentId)?.length
    )
      return;
    await receiveEvents(ctx, group, events);
    if (
      group.state !== "open" ||
      groups.get(parentId) !== group ||
      ctx.sessionsRefData.current.get(parentId)?.isSending
    )
      return;
    const parent = await window.snow.getChatConversation(parentId);
    if (!parent)
      throw new Error(
        "RUN_NOT_FOUND: original parent conversation is unavailable",
      );
    // The persisted receive may already be committed when an owner/task changes.
    // Do not receive again or dispatch from a stale renderer after the final await.
    if (
      group.state !== "open" ||
      groups.get(parentId) !== group ||
      ctx.sessionsRefData.current.get(parentId)?.isSending ||
      ctx.pendingQueueRef.current.get(parentId)?.length
    )
      return;
    const options = markSubAgentInternalInput(
      {
        apiProfile: parent.apiProfileName || undefined,
        model: parent.model || undefined,
        ...group.options,
        targetSessionKey: parentId,
      },
      {
        parentConversationId: parentId,
        parentTaskId: group.taskId,
        eventIds: events.map((event) => event.eventId),
      },
    );
    ctx.handleSendMessageRef.current(SUB_AGENT_RESULT_CONTINUATION, options);
    if (!ctx.sessionsRefData.current.get(parentId)?.isSending)
      throw new Error(
        "INVALID_TRANSITION: parent continuation was not accepted",
      );
  };
  void wake()
    .catch((error) => {
      // receive itself emits a change event. Never turn that self-notification
      // into an unbounded retry after failed admission; durable wake stays pending.
      group.wakeAgain = false;
      reportSubAgentParentError(ctx, parentId, error);
    })
    .finally(() => {
      group.waking = false;
      if (group.wakeAgain) scheduleSubAgentParent(parentId, ctx);
    });
};
export const stopSubAgentParentTask = async (
  ctx: ConversationContextValue,
  parentId: string,
): Promise<void> => {
  const group = groups.get(parentId);
  // Freeze stop eligibility before the first await. handleAbort may unlock the
  // parent immediately, so later queries must never acquire a new task/run.
  const capturedTaskId = group?.taskId ?? currentAgentTask(parentId)?.id;
  const capturedChildRunId = durableChildren.get(parentId);
  if (group && group.state === "open") {
    group.state = "stopped";
    await group.ready;
    if (group.scope)
      await command({
        op: "parent_task",
        scope: group.scope,
        parentTaskId: group.taskId,
        state: "stopped",
      });
  }
  const record = await window.snow.getChatConversation(parentId);
  if (!record || !record.directoryId) return;
  const scope = {
    projectId: record.directoryId,
    parentConversationId: record.parentConversationId || parentId,
  };
  const runs = await listRuns(scope);
  const targets = record.parentConversationId
    ? runs.filter(
        (run) =>
          run.conversationId === parentId && run.runId === capturedChildRunId,
      )
    : runs.filter((run) => run.parentTaskId === capturedTaskId);
  const results = await Promise.allSettled(
    targets
      .filter((run) => !isSubAgentTerminal(run.status))
      .map((run) =>
        requestOwnedSubAgentRunCancel(
          createSubAgentRunPersistence(ctx),
          scope,
          run.runId,
          record.parentConversationId ? "conversation_stop" : "parent_stop",
        ),
      ),
  );
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "PERSISTENCE_ERROR: one or more delegated runs did not stop",
    );
};
/** Archiving is a move, not a durable deletion request. Never cancel active runs. */
export const prepareSubAgentArchive = async (
  conversationId: string,
  stopParent: () => void,
): Promise<void> => {
  const record = await window.snow.getChatConversation(conversationId);
  if (record?.directoryId) {
    const receipt = await command({
      op: "deletion_status",
      scope: {
        projectId: record.directoryId,
        parentConversationId: record.parentConversationId || conversationId,
      },
      conversationId,
    });
    if (receipt.kind !== "deletion")
      throw new Error("PERSISTENCE_ERROR: invalid archive preparation");
    if (!receipt.ready)
      throw new Error(
        "RUN_BUSY: wait for delegated runs to finish before archiving",
      );
    // A terminal commit can precede the owner's final local writes. Drain those
    // owners without requesting cancellation; Rust rechecks under its write lock.
    for (const run of receipt.runs) {
      const local = await drainOwnedSubAgentRun(run.runId);
      if (!local && !isSubAgentTerminal(run.status))
        throw new Error(
          "OWNER_MISMATCH: archive is waiting for the execution owner",
        );
    }
  }
  const group = groups.get(conversationId);
  if (group) group.state = "stopped";
  if (!isDurableSubAgentConversation(conversationId)) stopParent();
};

const drainPreparedSubAgentRuns = async (
  scope: SubAgentRunScope,
  runs: SubAgentRunRecord[],
): Promise<void> => {
  // Child rollback closes the run's original root parent task in storage too.
  // Do not revoke an unrelated explicit replacement task in this renderer.
  const parentGroup = groups.get(scope.parentConversationId);
  if (
    parentGroup &&
    runs.some((run) => run.parentTaskId === parentGroup.taskId)
  )
    revokeSubAgentParentOwnership(scope.parentConversationId);
  for (const run of runs) {
    if (
      hasOwnedSubAgentRun(run.runId) &&
      run.status !== "finalizing" &&
      !isSubAgentTerminal(run.status)
    )
      await cancelOwnedSubAgentRun(run.runId);
    // Drain retained finished owners too: execution may be terminal while an
    // already installed resource stop is still pending or has failed.
    const local = await drainOwnedSubAgentRun(run.runId);
    if (!local && !isSubAgentTerminal(run.status))
      throw new Error(
        "OWNER_MISMATCH: mutation is waiting for the execution owner",
      );
  }
};

/** Close the in-memory wake owner before any asynchronous rollback preparation. */
export const prepareSubAgentRollback = async (
  conversationId: string,
  boundary: { fromMessageId?: string; fromResponseId?: string },
  stopParent?: () => void,
  onPrepared?: (identity: {
    scope: SubAgentRunScope;
    conversationId: string;
    rollbackId: string;
    phase: "prepared" | "restoring";
  }) => void,
): Promise<void> => {
  revokeSubAgentParentOwnership(conversationId);
  const record = await window.snow.getChatConversation(conversationId);
  if (!record?.directoryId)
    throw new Error("RUN_NOT_FOUND: rollback conversation is unavailable");
  if (Boolean(boundary.fromMessageId) === Boolean(boundary.fromResponseId))
    throw new Error(
      "VALIDATION_ERROR: exactly one rollback boundary is required",
    );
  const scope: SubAgentRunScope = {
    projectId: record.directoryId,
    parentConversationId: record.parentConversationId || conversationId,
  };
  const receipt = await command({
    op: "prepare_rollback",
    scope,
    conversationId,
    ...boundary,
  });
  if (receipt.kind !== "rollback")
    throw new Error("PERSISTENCE_ERROR: invalid rollback preparation");
  // Hand identity to the caller before draining: failures must remain releasable.
  onPrepared?.({
    scope,
    conversationId,
    rollbackId: receipt.rollbackId,
    phase: receipt.phase ?? "prepared",
  });
  if (!isDurableSubAgentConversation(conversationId)) stopParent?.();
  await drainPreparedSubAgentRuns(scope, receipt.runs);
  const settled = await command({
    op: "rollback_status",
    scope,
    conversationId,
    rollbackId: receipt.rollbackId,
  });
  if (
    settled.kind !== "rollback" ||
    settled.rollbackId !== receipt.rollbackId ||
    settled.boundaryMessageId !== receipt.boundaryMessageId ||
    !settled.ready
  )
    throw new Error("RUN_BUSY: delegated owners have not settled for rollback");
};

export const prepareSubAgentDeletion = async (
  ctx: ConversationContextValue,
  conversationId: string,
  stopParent?: () => void,
): Promise<void> => {
  revokeSubAgentParentOwnership(conversationId);
  const record = await window.snow.getChatConversation(conversationId);
  if (!record || !record.directoryId) return;
  const scope = {
    projectId: record.directoryId,
    parentConversationId: record.parentConversationId || conversationId,
  };
  const group = groups.get(conversationId);
  if (group) group.state = "stopped";
  const receipt = await command({
    op: "prepare_delete",
    scope,
    conversationId,
  });
  if (receipt.kind !== "deletion")
    throw new Error("PERSISTENCE_ERROR: invalid deletion preparation");
  // Stop the parent model/tool owner now, without destroying child state needed by finalizers.
  if (!isDurableSubAgentConversation(conversationId)) stopParent?.();
  await drainPreparedSubAgentRuns(scope, receipt.runs);
  const settled = await command({
    op: "deletion_status",
    scope,
    conversationId,
  });
  if (settled.kind !== "deletion" || !settled.ready)
    throw new Error(
      "DELETE_PENDING: delegated runs have not settled; deletion gate remains closed",
    );
  ctx.setConversationTreeVersion((version) => version + 1);
};
const cancellationDrains = new Map<string, Promise<void>>();
// One entry per locally admitted run; terminal commits retire their own tracking.
const ownerScopes = new Map<string, SubAgentRunScope>();
const drainOwnedCancellations = async (
  ctx: ConversationContextValue,
): Promise<void> => {
  const scopes = new Map(
    [...ownerScopes.values()].map((scope) => [
      scope.parentConversationId,
      scope,
    ]),
  );
  for (const scope of scopes.values()) {
    let runs: SubAgentRunRecord[];
    try {
      const parent = await window.snow.getChatConversation(
        scope.parentConversationId,
      );
      if (!parent) {
        // Deletion is an explicit retirement, not a permission error to retry forever.
        for (const [runId, tracked] of ownerScopes) {
          if (tracked.parentConversationId === scope.parentConversationId)
            ownerScopes.delete(runId);
        }
        revokeSubAgentParentOwnership(scope.parentConversationId);
        continue;
      }
      runs = await listRuns(scope);
    } catch (error) {
      reportSubAgentParentError(ctx, scope.parentConversationId, error);
      continue;
    }
    for (const run of runs) {
      if (
        (run.status !== "cancelling" && run.status !== "cancelled") ||
        !ownerScopes.has(run.runId) ||
        !hasOwnedSubAgentRun(run.runId) ||
        cancellationDrains.has(run.runId)
      )
        continue;
      const pending = cancelOwnedSubAgentRun(run.runId)
        .catch((error) =>
          reportSubAgentParentError(ctx, run.parentConversationId, error),
        )
        .finally(() => {
          cancellationDrains.delete(run.runId);
        });
      cancellationDrains.set(run.runId, pending);
    }
  }
};
let cancellationObserver: Promise<void> | undefined;
let cancellationObserverDirty = false;
const observeOwnedCancellations = (
  ctx: ConversationContextValue,
): Promise<void> => {
  cancellationObserverDirty = true;
  if (cancellationObserver) return cancellationObserver;
  cancellationObserver = Promise.resolve().then(async () => {
    try {
      while (cancellationObserverDirty) {
        cancellationObserverDirty = false;
        await drainOwnedCancellations(ctx);
      }
    } finally {
      // Clear synchronously with the last pass so a new invalidation cannot be lost.
      cancellationObserver = undefined;
    }
  });
  return cancellationObserver;
};
export const useSubAgentParentInbox = (
  ctx: ConversationContextValue,
  deps: Pick<SubAgentActivationDeps, "requestToolAuthorizations">,
  enabled = true,
  isDetachedWindow = false,
): void => {
  const latest = useRef({ ctx, deps });
  latest.current = { ctx, deps };
  useEffect(() => {
    if (!enabled) return;
    const owner = {
      getCtx: () => latest.current.ctx,
      deps: () => latest.current.deps,
    };
    runtime = owner;
    const removeResolver = setSubAgentRunActionResolver((parentId) => ({
      async continueRun(conversationId, message, requestId) {
        const current = owner.getCtx();
        // Do not create a second parent group from a main-window history card.
        // Main IPC rechecks this ownership immediately before durable dispatch.
        if (
          !isDetachedWindow &&
          (await window.snow.takeDetachedConversationOwners()).includes(
            parentId,
          )
        ) {
          throw new Error(
            "OWNER_MISMATCH: continue this conversation in its detached window",
          );
        }
        const parent = await window.snow.getChatConversation(parentId);
        if (!parent)
          throw new Error("RUN_NOT_FOUND: parent conversation is unavailable");
        current.ensureSession(parentId, parent.directoryId);
        const modes = await window.snow.getConversationModes(parentId);
        const ref = current.sessionsRefData.current.get(parentId);
        if (ref && !ref.isSending) {
          ref.goalMode = modes.goalMode ?? false;
          ref.worktreeMode = modes.worktreeMode ?? false;
        }
        if (!parent.directoryId)
          throw new Error(
            "UNSUPPORTED_EXECUTION_MODE: async continuation requires a project-bound conversation",
          );
        const temporaryTask = currentAgentTask(parentId)
          ? undefined
          : startAgentTask(parentId);
        if (temporaryTask) {
          beginSubAgentParentTask(parentId, temporaryTask.id, {
            apiProfile: parent.apiProfileName || undefined,
            model: parent.model || undefined,
          });
        }
        const executor = createSubAgentMainToolExecutor(current, {
          ...owner.deps(),
          runPersistence: createSubAgentRunPersistence(
            current,
            getSubAgentParentTaskId(parentId),
          ),
        });
        try {
          const result = await executor(
            "sub-agents-continue",
            JSON.stringify({
              conversationId,
              message,
              requestId,
            }),
            parentId,
            [],
            "async",
          );
          const receipt: unknown = JSON.parse(result);
          if (
            !receipt ||
            typeof receipt !== "object" ||
            !("success" in receipt) ||
            receipt.success !== true
          )
            throw new Error(
              typeof receipt === "object" && receipt && "error" in receipt
                ? String(receipt.error)
                : "PERSISTENCE_ERROR: invalid continuation receipt",
            );
          return result;
        } finally {
          if (temporaryTask) await finishAgentTask(temporaryTask, parentId);
        }
      },
      async cancelRun(runId) {
        const current = owner.getCtx();
        return requestOwnedSubAgentRunCancel(
          createSubAgentRunPersistence(current),
          await resolveSubAgentRunScope(parentId),
          runId,
          "ui_cancel",
        );
      },
    }));
    const unsubscribe = window.snow.onSubAgentRunsChanged(() => {
      notifySubAgentRunChanges();
      void observeOwnedCancellations(owner.getCtx()).catch(() => {
        console.error("[sub-agent-owner] cancellation observer failed", {
          code: "PERSISTENCE_ERROR",
        });
      });
      for (const parentId of groups.keys()) scheduleSubAgentParent(parentId);
    });
    // Read after subscription. Restarted runs remain retained, not silently reopened.
    for (const parentId of groups.keys()) scheduleSubAgentParent(parentId);
    // Presentation-only repair: settle synthetic result cards that are already
    // pending in memory (e.g. after a renderer reload) from persisted history.
    for (const parentId of Object.keys(owner.getCtx().sessionsRef.current)) {
      void reconcileSubAgentSyntheticResults(owner.getCtx(), parentId).catch(
        () => {
          // Best-effort; durable delivery state is unaffected.
        },
      );
    }
    return () => {
      unsubscribe();
      removeResolver();
      if (runtime === owner) runtime = undefined;
    };
  }, [enabled, isDetachedWindow]);
};
