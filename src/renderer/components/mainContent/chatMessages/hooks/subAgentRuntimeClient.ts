import { useCallback, useEffect, useRef, useState } from "react";

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
let actionResolver: ((parentId: string) => RuntimeActions) | undefined;
export const setSubAgentRunActionResolver = (
  resolver: (parentId: string) => RuntimeActions,
): (() => void) => {
  actionResolver = resolver;
  return () => {
    if (actionResolver === resolver) actionResolver = undefined;
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
/** 父会话已被归档或删除时没有可展示的运行事实，按空结果处理而非错误。 */
const isParentGone = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith("RUN_NOT_FOUND:");
const getSubAgentRunResult = async (
  parentConversationId: string,
  runId: string,
  offset = 0,
  terminalOnly = false,
): Promise<SubAgentResultPage> => {
  const scope = await resolveSubAgentRunScope(parentConversationId);
  const result = await window.snow.subAgentRunCommand({
    op: "get",
    scope,
    runId,
    offset,
    limit: 16000,
    terminalOnly,
  });
  if (result.kind !== "result" || !result.run)
    throw new Error("PERSISTENCE_ERROR: invalid get result response");
  if (result.run.runId !== runId)
    throw new Error("PERSISTENCE_ERROR: mismatched get result run");
  if (
    result.run.parentConversationId !== scope.parentConversationId ||
    result.run.projectId !== scope.projectId ||
    (result.run.outcome &&
      (result.run.outcome.runId !== runId ||
        result.run.outcome.parentConversationId !== scope.parentConversationId))
  )
    throw new Error("PERMISSION_DENIED: mismatched get result scope");
  return result;
};

/** Exact, read-only result lookup; never scans runs or consumes delivery events. */
export const useSubAgentRunResult = (
  parentConversationId?: string,
  request?: { runId: string; offset: number } | null,
) => {
  const runId = request?.runId;
  const offset = request?.offset ?? 0;
  const key =
    parentConversationId && runId
      ? JSON.stringify([parentConversationId, runId, offset])
      : undefined;
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<{
    key?: string;
    result?: SubAgentResultPage;
    error: string | null;
    loading: boolean;
  }>({ error: null, loading: false });
  const refresh = useCallback(async (): Promise<void> => {
    generation.current += 1;
    const token = generation.current;
    if (!key || !parentConversationId || !runId) return;
    setSnapshot((previous) => ({
      key,
      result: previous.key === key ? previous.result : undefined,
      error: null,
      loading: true,
    }));
    try {
      const result = await getSubAgentRunResult(
        parentConversationId,
        runId,
        offset,
        true,
      );
      if (generation.current !== token) return;
      setSnapshot({ key, result, error: null, loading: false });
    } catch (error) {
      if (generation.current !== token) return;
      setSnapshot((previous) => ({
        key,
        result: previous.key === key ? previous.result : undefined,
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      }));
    }
  }, [key, parentConversationId, runId, offset]);
  useEffect(() => {
    if (!key) return;
    const unsubscribe = window.snow.onSubAgentRunsChanged(() => void refresh());
    void refresh();
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [key, refresh]);
  const result = key && snapshot.key === key ? snapshot.result : undefined;
  return {
    result,
    runs: result ? [result.run] : [],
    loading: Boolean(key) && (snapshot.key !== key || snapshot.loading),
    error: key && snapshot.key === key ? snapshot.error : null,
    refresh,
  };
};
export const requestSubAgentRunCancel = (
  parentId: string,
  runId: string,
): Promise<SubAgentCancelReceipt> => {
  const owner = actionResolver?.(parentId);
  if (!owner)
    return Promise.reject(
      new Error(
        "OWNER_MISMATCH: open the parent conversation runtime before cancelling",
      ),
    );
  return owner.cancelRun(runId);
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
      // 已归档/已删除的父会话没有运行事实可读，按空列表处理而不是错误态。
      if (isParentGone(error)) {
        setSnapshot({ parentId: parentConversationId, runs: [], error: null });
        return;
      }
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
