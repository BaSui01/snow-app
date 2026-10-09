import type {
  StreamInterruptionReason,
  StreamRecoveryOutcome,
} from "../../../../../preload";

export type IncompleteVariant =
  "partial_content" | "thinking_only" | "tool_call" | "empty";

export type NormalizedInterruptionReason = StreamInterruptionReason | "unknown";

export type NormalizedRecoveryOutcome =
  StreamRecoveryOutcome | "unknown" | null;

export type ResponseDispositionInput = {
  status?: string | null;
  content?: string | null;
  thinking?: string | null;
  toolCallsJson?: string | null;
  interruptionReason?: string | null;
  recoveryOutcome?: string | null;
};

export type ResponseDisposition =
  | {
      kind: "complete";
      mayExecuteTools: true;
      mayContinueLoop: true;
    }
  | {
      kind: "error";
      mayExecuteTools: false;
      mayContinueLoop: false;
    }
  | {
      kind: "incomplete";
      variant: IncompleteVariant;
      reason: NormalizedInterruptionReason;
      recoveryOutcome: NormalizedRecoveryOutcome;
      mayExecuteTools: false;
      mayContinueLoop: false;
    };

const normalizeInterruptionReason = (
  value: string | null | undefined,
  status: string | null | undefined,
): NormalizedInterruptionReason => {
  switch (value) {
    case "unexpected_eof":
    case "read_error":
    case "idle_timeout":
    case "explicit_incomplete":
    case "output_limit":
    case "empty_response":
      return value;
    default:
      return value == null && (status === "length" || status === "max_tokens")
        ? "output_limit"
        : "unknown";
  }
};

const normalizeRecoveryOutcome = (
  value: string | null | undefined,
): NormalizedRecoveryOutcome => {
  if (value == null) {
    return null;
  }

  switch (value) {
    case "partial_threshold":
    case "retry_exhausted":
    case "non_retriable":
      return value;
    default:
      return "unknown";
  }
};

const hasUnsafeToolPayload = (
  toolCallsJson: string | null | undefined,
): boolean => {
  if (typeof toolCallsJson !== "string") {
    return false;
  }

  const normalized = toolCallsJson.trim();
  return normalized !== "" && normalized !== "[]" && normalized !== "null";
};

/**
 * 空响应终态：Provider 以 `completed` 收尾，但正文、思考与工具调用全为空。
 *
 * Rust 侧在空响应重试预算耗尽时会标记 `interruption_reason=empty_response`
 * （见 native/src/api/retry.rs::resolve_empty_response_terminal）；本次修复之前
 * 落库的历史消息没有该标记，因此这里同时按「completed 且完全无载荷」兜底判定。
 * 否则这类回复与「正常完成」完全同形，前端只能渲染一个空白气泡、不给任何提示。
 */
const isEmptyResponseTerminal = (input: ResponseDispositionInput): boolean => {
  if (input.interruptionReason === "empty_response") {
    return true;
  }

  return (
    input.status === "completed" &&
    !input.content?.trim() &&
    !input.thinking?.trim() &&
    !hasUnsafeToolPayload(input.toolCallsJson)
  );
};

export const resolveResponseDisposition = (
  input: ResponseDispositionInput,
): ResponseDisposition => {
  if (input.status === "error" || input.status === "failed") {
    return {
      kind: "error",
      mayExecuteTools: false,
      mayContinueLoop: false,
    };
  }

  const isIncompleteLike =
    input.status === "incomplete" ||
    input.status === "length" ||
    input.status === "max_tokens" ||
    isEmptyResponseTerminal(input);
  if (!isIncompleteLike) {
    return {
      kind: "complete",
      mayExecuteTools: true,
      mayContinueLoop: true,
    };
  }

  let variant: IncompleteVariant;
  if (hasUnsafeToolPayload(input.toolCallsJson)) {
    variant = "tool_call";
  } else if (input.content?.trim()) {
    variant = "partial_content";
  } else if (input.thinking?.trim()) {
    variant = "thinking_only";
  } else {
    variant = "empty";
  }

  return {
    kind: "incomplete",
    variant,
    // 空响应终态统一回报 empty_response（Rust 侧显式标记，或「completed 且
    // 完全无载荷」的历史兜底）：前端据此复用重试提示渲染终态，而不是只留
    // 一个没有任何提示的空白气泡。
    reason: isEmptyResponseTerminal(input)
      ? "empty_response"
      : normalizeInterruptionReason(input.interruptionReason, input.status),
    recoveryOutcome: normalizeRecoveryOutcome(input.recoveryOutcome),
    mayExecuteTools: false,
    mayContinueLoop: false,
  };
};
