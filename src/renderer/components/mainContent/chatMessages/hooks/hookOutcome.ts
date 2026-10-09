import type { HookExecuteResult } from "../../../../../preload";
import { tGlobal } from "../../../../i18n";
import type {
  ChatConversationMessage,
  HookExecutionRecord,
} from "../utils/conversationTypes";

/**
 * Unified interpretation of a hook execution result based on exit-code semantics:
 *
 * - exit 0  → pass:  stdout becomes `additionalContext` (and raw `output`);
 *            for interactive tools the raw output can serve as the tool result.
 * - exit 1  → warn:  carry the command's output/error as a warning message;
 *            if the command produced nothing, fall back to a built-in notice.
 * - exit 2+ → abort: the AI loop must be fully interrupted and cancelled,
 *            surfacing the hook's error message.
 */
export type HookOutcome =
  | { kind: "pass"; context: string | null; output: string | null }
  | { kind: "warn"; message: string }
  | { kind: "abort"; message: string }
  | { kind: "needsDecision"; message: string };

/**
 * Hook 未给出具体文案时的兜底提示。按当前 App 语言在调用时求值（而不是
 * 模块加载时），因此语言切换后新产生的提示即时跟随。
 */
const unknownWarning = (): string => tGlobal("chat.hook.unknownWarning");
const unknownBlock = (): string => tGlobal("chat.hook.unknownBlock");

export const resolveHookOutcome = (result: HookExecuteResult): HookOutcome => {
  if (result.blocked) {
    return {
      kind: "abort",
      message: result.blockMessage || unknownBlock(),
    };
  }

  if (result.requiresDecision) {
    return {
      kind: "needsDecision",
      message: result.decisionMessage || unknownWarning(),
    };
  }

  if (result.softSignal) {
    const warning = result.results
      .map((record) => record.output || record.error)
      .filter((value): value is string => Boolean(value))
      .join("\n")
      .trim();
    return {
      kind: "warn",
      message: warning || unknownWarning(),
    };
  }

  const context = result.results
    .map((record) => record.additionalContext)
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .trim();

  const output =
    result.results
      .map((record) => record.output)
      .find((value): value is string => Boolean(value)) ?? null;

  return {
    kind: "pass",
    context: context || null,
    output,
  };
};

/**
 * Build a HookExecutionRecord from a raw HookExecuteResult and its resolved
 * outcome.  Used by every hook invocation site to keep the record structure
 * consistent.
 */
export const buildHookExecRecord = (
  hookType: string,
  result: HookExecuteResult,
  outcome: HookOutcome,
): HookExecutionRecord => ({
  hookType,
  status: outcome.kind,
  executedActions: result.executedActions,
  skippedActions: result.skippedActions,
  results: result.results,
  blockMessage: result.blockMessage ?? null,
  timestamp: Date.now(),
  pendingDecision: outcome.kind === "needsDecision",
  decisionMessage: outcome.kind === "needsDecision" ? outcome.message : null,
});

export const appendHookExecutionToMessage = (
  messages: ChatConversationMessage[],
  record: HookExecutionRecord,
  messageId?: string,
): ChatConversationMessage[] => {
  const targetIndex = messageId
    ? messages.findIndex((message) => message.id === messageId)
    : messages.findLastIndex((message) => message.role !== "tool");

  if (targetIndex < 0) {
    return messages;
  }

  return messages.map((message, index) =>
    index === targetIndex
      ? {
          ...message,
          hookExecutions: [...(message.hookExecutions ?? []), record],
        }
      : message,
  );
};

/**
 * Fire-and-forget hooks (onStop, onSessionStart) can never block the flow and
 * have no resolver wired up, so a decision outcome must not render as a pending
 * decision card (its approve/reject buttons would do nothing). Downgrade such a
 * record to a plain warning: the hook's message is preserved via blockMessage so
 * it stays visible in the expanded detail, but no interactive decision is shown.
 */
export const toNonBlockingRecord = (
  record: HookExecutionRecord,
): HookExecutionRecord => {
  if (!record.pendingDecision) {
    return record;
  }
  return {
    ...record,
    status: "warn",
    pendingDecision: false,
    blockMessage: record.decisionMessage ?? record.blockMessage ?? null,
    decisionMessage: null,
    _decisionId: undefined,
    _resolveDecision: undefined,
  };
};

/**
 * High-level helper: execute a hook via the Rust backend, resolve the
 * outcome, and return both the raw result and a structured record suitable
 * for UI rendering.  Returns null when the hook type has no configured rules
 * (executedActions === 0 && skippedActions === 0), so callers can skip
 * unnecessary processing.
 */
export const runHook = async (
  hookType: string,
  projectId: string | undefined,
  contextJson: string,
): Promise<{
  result: HookExecuteResult;
  outcome: HookOutcome;
  record: HookExecutionRecord;
} | null> => {
  const result = await window.snow.executeHooks({
    hookType,
    projectId: projectId || undefined,
    contextJson,
  });

  // No rules configured for this hook type — skip.
  if (result.executedActions === 0 && result.skippedActions === 0) {
    return null;
  }

  const outcome = resolveHookOutcome(result);
  const record = buildHookExecRecord(hookType, result, outcome);
  return { result, outcome, record };
};
