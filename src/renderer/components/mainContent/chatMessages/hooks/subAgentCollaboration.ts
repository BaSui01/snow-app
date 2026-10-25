import type {
  SubAgentRunRecord,
  SubAgentRunScope,
} from "../../../../../shared/subAgentRuns";
import { isSubAgentTerminal } from "../../../../../shared/subAgentRuns";
import { parseSubAgentTools } from "./subAgentRuntimeConfig";
import type { SubAgentRunPersistence } from "./subAgentRunRegistry";

export const parseCollaborationGroup = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Array.from(value).length > 80
  )
    throw new Error(
      "VALIDATION_ERROR: collaborationGroup must contain 1..80 characters",
    );
  return value.trim();
};

/** Wildcard grants ordinary tools, not ambient communication. Native applies the same exclusion. */
export const collaborationToolsJson = (
  toolsJson: string,
  group?: string,
): string => {
  const tools = parseSubAgentTools(toolsJson);
  const permitted =
    tools.includes("sub-agents-sendMessage") || tools.includes("*");
  const ordinary = tools.filter((tool) => !tool.startsWith("sub-agents-"));
  return JSON.stringify(
    group && permitted ? [...ordinary, "sub-agents-sendMessage"] : ordinary,
  );
};

export const executePeerMessage = async (
  persistence: SubAgentRunPersistence | undefined,
  scope: SubAgentRunScope,
  senderRunId: string,
  argsJson: string,
  toolsJson: string,
  hostRequestId?: string,
): Promise<string> => {
  if (
    !persistence ||
    !parseSubAgentTools(toolsJson).includes("sub-agents-sendMessage")
  )
    throw new Error(
      "PERMISSION_DENIED: this run has no durable collaboration authorization",
    );
  const validationFailure = (error: string): string =>
    JSON.stringify({ success: false, error, code: "VALIDATION_ERROR" });
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return validationFailure("Peer message arguments must be valid JSON");
  }
  if (!args || typeof args !== "object" || Array.isArray(args))
    return validationFailure("Peer message arguments must be an object");
  const value = args as Record<string, unknown>;
  const requestId = hostRequestId ?? value.requestId;
  if (
    typeof value.recipientRunId !== "string" ||
    !value.recipientRunId.trim() ||
    typeof value.message !== "string" ||
    !value.message.trim() ||
    typeof requestId !== "string" ||
    !requestId.trim() ||
    requestId.length > 160
  )
    return validationFailure(
      "recipientRunId, message and stable requestId are required",
    );
  const result = await persistence.command({
    op: "peer_message",
    scope,
    senderRunId,
    recipientRunId: value.recipientRunId.trim(),
    message: value.message,
    requestId,
  });
  if (result.kind !== "message_queued")
    throw new Error(
      "PERSISTENCE_ERROR: peer_message returned an unexpected receipt",
    );
  return JSON.stringify(result);
};

export const activeConversationRun = async (
  persistence: SubAgentRunPersistence,
  scope: SubAgentRunScope,
  conversationId: string,
): Promise<SubAgentRunRecord | undefined> => {
  const result = await persistence.command({
    op: "list",
    scope,
    conversationId,
    limit: 1,
  });
  if (result.kind !== "runs")
    throw new Error("PERSISTENCE_ERROR: invalid run list");
  const latest = result.runs[0];
  return latest && !isSubAgentTerminal(latest.status) ? latest : undefined;
};
