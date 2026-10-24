import { useCallback, useEffect, useRef, useState } from "react";

const deletionErrors = new Map<string, string>();
const DELETION_ERROR_EVENT = "snow:sub-agent-deletion-error";
export const setSubAgentDeletionError = (
  conversationId: string,
  message: string | null,
): void => {
  if (message) deletionErrors.set(conversationId, message);
  else deletionErrors.delete(conversationId);
  window.dispatchEvent(new Event(DELETION_ERROR_EVENT));
};
export const useSubAgentDeletionStatus = (
  parentConversationId?: string,
  conversationId?: string,
): {
  deleting: boolean;
  ready: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} => {
  const revision = useRef(0);
  const [snapshot, setSnapshot] = useState({
    id: "",
    deleting: false,
    ready: false,
    error: null as string | null,
  });
  const refresh = useCallback(async (): Promise<void> => {
    const token = ++revision.current;
    if (!parentConversationId || !conversationId) return;
    try {
      const scope = await resolveSubAgentRunScope(parentConversationId);
      if (token !== revision.current) return;
      if (!scope.projectId) {
        if (token === revision.current)
          setSnapshot({
            id: conversationId,
            deleting: false,
            ready: true,
            error: deletionErrors.get(conversationId) ?? null,
          });
        return;
      }
      const result = await window.snow.subAgentRunCommand({
        op: "deletion_status",
        scope,
        conversationId,
      });
      if (result.kind !== "deletion")
        throw new Error("PERSISTENCE_ERROR: invalid deletion status response");
      if (token === revision.current)
        setSnapshot({
          id: conversationId,
          deleting: result.deleting,
          ready: result.ready,
          error:
            result.error?.message ?? deletionErrors.get(conversationId) ?? null,
        });
    } catch (error) {
      if (token === revision.current)
        setSnapshot((previous) => ({
          ...previous,
          id: conversationId,
          error: error instanceof Error ? error.message : String(error),
        }));
    }
  }, [parentConversationId, conversationId]);
  useEffect(() => {
    const unsubscribe = window.snow.onSubAgentRunsChanged(() => {
      void refresh();
    });
    const localRefresh = (): void => {
      void refresh();
    };
    window.addEventListener(DELETION_ERROR_EVENT, localRefresh);
    void refresh();
    return () => {
      ++revision.current;
      unsubscribe();
      window.removeEventListener(DELETION_ERROR_EVENT, localRefresh);
    };
  }, [refresh]);
  return {
    deleting: snapshot.id === conversationId && snapshot.deleting,
    ready: snapshot.id === conversationId && snapshot.ready,
    error: snapshot.id === conversationId ? snapshot.error : null,
    refresh,
  };
};
import type {
  SubAgentCancelReceipt,
  SubAgentResultPage,
  SubAgentRunRecord,
  SubAgentRunScope,
} from "../../../../../shared/subAgentRuns";

type RuntimeActions = {
  continueRun(
    conversationId: string,
    message: string,
    requestId: string,
  ): Promise<string>;
  cancelRun(runId: string): Promise<SubAgentCancelReceipt>;
};
const actions = new Map<string, RuntimeActions>();
let actionResolver: ((parentId: string) => RuntimeActions) | undefined;
export const setSubAgentRunActionResolver = (
  resolver: (parentId: string) => RuntimeActions,
): (() => void) => {
  actionResolver = resolver;
  return () => {
    if (actionResolver === resolver) actionResolver = undefined;
  };
};
/** Runtime owner registration, never a UI-generated user message. */
export const registerSubAgentRunActions = (
  parentId: string,
  owner: RuntimeActions,
): (() => void) => {
  const existing = actions.get(parentId);
  if (existing && existing !== owner)
    throw new Error("RUN_BUSY: parent runtime already registered");
  actions.set(parentId, owner);
  return () => {
    if (actions.get(parentId) === owner) actions.delete(parentId);
  };
};
export const resolveSubAgentRunScope = async (
  parentConversationId: string,
): Promise<SubAgentRunScope> => {
  const record = await window.snow.getChatConversation(parentConversationId);
  if (!record)
    throw new Error("RUN_NOT_FOUND: parent conversation does not exist");
  return { projectId: record.directoryId, parentConversationId };
};
export const getSubAgentRunResult = async (
  parentConversationId: string,
  runId: string,
  offset = 0,
): Promise<SubAgentResultPage> => {
  const scope = await resolveSubAgentRunScope(parentConversationId);
  const result = await window.snow.subAgentRunCommand({
    op: "get",
    scope,
    runId,
    offset,
    limit: 16000,
  });
  if (result.kind !== "result")
    throw new Error("PERSISTENCE_ERROR: invalid get result response");
  return result;
};
export const requestSubAgentRunCancel = (
  parentId: string,
  runId: string,
): Promise<SubAgentCancelReceipt> => {
  const owner = actions.get(parentId) ?? actionResolver?.(parentId);
  if (!owner)
    return Promise.reject(
      new Error(
        "OWNER_MISMATCH: open the parent conversation runtime before cancelling",
      ),
    );
  return owner.cancelRun(runId);
};
export const requestSubAgentRunContinue = (
  parentId: string,
  conversationId: string,
  message: string,
  requestId: string,
): Promise<string> => {
  const owner = actions.get(parentId) ?? actionResolver?.(parentId);
  if (!owner)
    return Promise.reject(
      new Error(
        "OWNER_MISMATCH: open the parent conversation runtime before continuing",
      ),
    );
  return owner.continueRun(conversationId, message, requestId);
};
export const useSubAgentRuns = (
  parentConversationId?: string,
): {
  runs: readonly SubAgentRunRecord[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} => {
  const revision = useRef(0);
  const [loading, setLoading] = useState(Boolean(parentConversationId));
  const [snapshot, setSnapshot] = useState<{
    parentId?: string;
    runs: SubAgentRunRecord[];
    error: string | null;
  }>({ runs: [], error: null });
  const refresh = useCallback(async (): Promise<void> => {
    const token = ++revision.current;
    if (!parentConversationId) {
      setLoading(false);
      setSnapshot({ runs: [], error: null });
      return;
    }
    setLoading(true);
    try {
      const scope = await resolveSubAgentRunScope(parentConversationId);
      if (token !== revision.current) return;
      if (!scope.projectId) {
        if (token === revision.current)
          setSnapshot({
            parentId: parentConversationId,
            runs: [],
            error: null,
          });
        return;
      }
      const runs: SubAgentRunRecord[] = [];
      let offset = 0;
      for (;;) {
        if (token !== revision.current) return;
        const result = await window.snow.subAgentRunCommand({
          op: "list",
          scope,
          limit: 100,
          offset,
        });
        if (result.kind !== "runs")
          throw new Error("PERSISTENCE_ERROR: invalid run list response");
        runs.push(...result.runs);
        offset += result.runs.length;
        if (offset >= result.total) break;
        if (!result.runs.length)
          throw new Error("PERSISTENCE_ERROR: incomplete run list page");
      }
      if (token === revision.current)
        setSnapshot({ parentId: parentConversationId, runs, error: null });
    } catch (error) {
      if (token !== revision.current) return;
      setSnapshot((previous) => ({
        parentId: parentConversationId,
        runs: previous.parentId === parentConversationId ? previous.runs : [],
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      if (token === revision.current) setLoading(false);
    }
  }, [parentConversationId]);
  useEffect(() => {
    // Subscribe first, then query: invalidation is not an authoritative result.
    const unsubscribe = window.snow.onSubAgentRunsChanged(() => {
      void refresh();
    });
    void refresh();
    return () => {
      ++revision.current;
      unsubscribe();
    };
  }, [refresh]);
  return {
    runs: snapshot.parentId === parentConversationId ? snapshot.runs : [],
    loading:
      Boolean(parentConversationId) &&
      (loading || snapshot.parentId !== parentConversationId),
    error: snapshot.parentId === parentConversationId ? snapshot.error : null,
    refresh,
  };
};
