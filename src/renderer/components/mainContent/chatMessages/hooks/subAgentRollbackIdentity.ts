import type { SubAgentRunScope } from "../../../../../shared/subAgentRuns";

export type SubAgentRollbackIdentity = {
  scope: SubAgentRunScope;
  conversationId: string;
  rollbackId: string;
  phase: "prepared" | "restoring";
};

export const releasePreparedSubAgentRollback = async (
  identity: SubAgentRollbackIdentity,
): Promise<void> => {
  if (identity.phase !== "prepared") throw new Error("ROLLBACK_RETRY_REQUIRED");
  const result = await window.snow.subAgentRunCommand({
    op: "release_rollback",
    scope: identity.scope,
    conversationId: identity.conversationId,
    rollbackId: identity.rollbackId,
  });
  if (
    result.kind !== "rollback_released" ||
    result.rollbackId !== identity.rollbackId
  )
    throw new Error("PERSISTENCE_ERROR: invalid rollback release");
};

export const markSubAgentRollbackRestoring = async (
  identity: SubAgentRollbackIdentity,
): Promise<void> => {
  const result = await window.snow.subAgentRunCommand({
    op: "mark_rollback_restoring",
    scope: identity.scope,
    conversationId: identity.conversationId,
    rollbackId: identity.rollbackId,
  });
  if (
    result.kind !== "rollback" ||
    result.rollbackId !== identity.rollbackId ||
    result.phase !== "restoring" ||
    !result.ready
  )
    throw new Error(
      "PERSISTENCE_ERROR: rollback is not ready for file restoration",
    );
  identity.phase = "restoring";
};
