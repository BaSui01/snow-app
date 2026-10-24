import { writeRendererLog } from "../../../../utils/rendererLog";
import type { RecoverableReadReason } from "./subAgentToolFailure";
import type { SubAgentCancellation } from "../../../../../shared/subAgentRuns";

export type SubAgentDiagnosticReason =
  | RecoverableReadReason
  | "TOOL_STARTED"
  | "TOOL_COMPLETED"
  | "TOOL_EXECUTION_FAILED"
  | "TOOL_RECOVERY_EXHAUSTED"
  | "PERMISSION_DENIED"
  | "RUN_CANCELLED"
  | "MODEL_REQUEST_FAILED"
  | "SUB_AGENT_EXECUTION_FAILED"
  | "PERSISTENCE_ERROR"
  | "RUN_STARTED"
  | "RUN_COMPLETED"
  | "RUN_FAILED";

type DiagnosticEvent =
  | "toolStarted"
  | "toolCompleted"
  | "recovery"
  | "fatal"
  | "runStarted"
  | "runSettled";
export type SubAgentDiagnosticContext = {
  runId: string;
  conversationId: string;
  parentConversationId: string;
  toolName?: string;
  callId?: string;
  interactionId?: string;
  reasonCode: SubAgentDiagnosticReason;
  decision?:
    "continue" | "stop" | "cancel" | "completed" | "failed" | "cancelled";
  consecutiveRounds?: number;
  recoveryLimit?: number;
  elapsedMs?: number;
  emptyText?: boolean;
  cancellation?: SubAgentCancellation;
};

/** No arbitrary payloads, errors or messages cross this logging boundary. */
export const logSubAgentDiagnostic = (
  event: DiagnosticEvent,
  context: SubAgentDiagnosticContext,
): void => {
  try {
    const level =
      event === "recovery"
        ? "WARN"
        : event === "fatal"
          ? "ERROR"
          : event === "toolStarted" || event === "toolCompleted"
            ? "DEBUG"
            : "INFO";
    writeRendererLog(level, {
      module: "sub-agent/runtime",
      func: event,
      message: event,
      // Explicit projection also drops extra properties supplied by callers.
      context: JSON.stringify({
        runId: context.runId,
        conversationId: context.conversationId,
        parentConversationId: context.parentConversationId,
        toolName: context.toolName,
        callId: context.callId,
        interactionId: context.interactionId,
        reasonCode: context.reasonCode,
        decision: context.decision,
        consecutiveRounds: context.consecutiveRounds,
        recoveryLimit: context.recoveryLimit,
        elapsedMs: context.elapsedMs,
        emptyText: context.emptyText,
        cancellation: context.cancellation
          ? {
              source: context.cancellation.source,
              requestedAt: context.cancellation.requestedAt,
            }
          : undefined,
      }),
      duration:
        context.elapsedMs === undefined ? undefined : `${context.elapsedMs}ms`,
    });
  } catch {
    // Serialization and logger failures must never alter run control flow.
  }
};
