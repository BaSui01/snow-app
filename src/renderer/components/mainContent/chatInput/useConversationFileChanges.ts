import { useEffect, useMemo, useState } from "react";
import type {
  ChatConversationMessage,
  FileChangeRecord,
} from "../chatMessages/utils/conversationTypes";

type UseConversationFileChangesParams = {
  conversationId?: string;
  checkpointIds?: string[];
  baselineCheckpointId?: string;
  workDir?: string;
  messages: ChatConversationMessage[];
  conversationVersion: number;
  fallbackChanges: FileChangeRecord[];
};

type CheckpointDiffs = Awaited<
  ReturnType<typeof window.snow.listCheckpointDiffsBatch>
>;

type CheckpointDiffState = {
  requestKey: string;
  diffs: CheckpointDiffs | null;
};

const normalizePath = (filePath: string): string =>
  filePath.replaceAll("\\", "/").replace(/^\.\/+/, "").toLowerCase();

const findFallbackChange = (
  checkpointPath: string,
  fallbackChanges: FileChangeRecord[]
): FileChangeRecord | undefined => {
  const normalizedCheckpointPath = normalizePath(checkpointPath);
  return fallbackChanges.find((change) => {
    const normalizedToolPath = normalizePath(change.filePath);
    return (
      normalizedToolPath === normalizedCheckpointPath ||
      normalizedToolPath.endsWith(`/${normalizedCheckpointPath}`)
    );
  });
};

const toFileChangeKind = (
  changeType: string
): FileChangeRecord["kind"] => {
  if (changeType === "added") {
    return "create";
  }
  if (changeType === "deleted") {
    return "delete";
  }
  return "edit";
};

/**
 * Returns the conversation's file modifications: the net workspace diff from
 * its first local checkpoint, merged with the tool-recorded statistics.
 *
 * The checkpoint view reports every captured file (includeAll=true), so later
 * runs drifting the shared working tree cannot erase an earlier
 * conversation's modifications; tool-recorded changes that the checkpoint
 * does not cover (deleted checkpoints, capture failures, SSH workspaces) are
 * appended from the fallback statistics. Remote workspaces and unavailable
 * checkpoint APIs retain the tool-recorded approximation so SSH statistics
 * continue to work.
 */
export const useConversationFileChanges = ({
  conversationId,
  checkpointIds,
  baselineCheckpointId,
  workDir,
  messages,
  conversationVersion,
  fallbackChanges,
}: UseConversationFileChangesParams): FileChangeRecord[] => {
  const completedToolSignature = useMemo(
    () =>
      messages
        .flatMap((message) => message.toolCalls ?? [])
        .filter((toolCall) => toolCall.status === "completed")
        .map(
          (toolCall) =>
            `${toolCall.interactionId}:${toolCall.status}:${toolCall.result?.length ?? 0}`
        )
        .join("|"),
    [messages]
  );

  const orderedCheckpointIds = useMemo(
    () => [...new Set(checkpointIds ?? [])],
    [checkpointIds]
  );
  const canUseCheckpoint = Boolean(
    workDir && (orderedCheckpointIds.length > 0 || baselineCheckpointId)
  );
  const requestKey = JSON.stringify([
    conversationId ?? "",
    orderedCheckpointIds,
    baselineCheckpointId ?? "",
    workDir ?? "",
    completedToolSignature,
    conversationVersion,
  ]);
  const [checkpointState, setCheckpointState] =
    useState<CheckpointDiffState>({ requestKey: "", diffs: null });

  useEffect(() => {
    if (!canUseCheckpoint || !workDir) {
      return;
    }

    let cancelled = false;
    const loadCheckpointDiffs = async (): Promise<void> => {
      let ids = orderedCheckpointIds;
      if (conversationId) {
        try {
          const fullHistory = await window.snow.listChatMessages(conversationId);
          const persistedIds = fullHistory
            .filter((record) => record.role === "user" && record.checkpointId)
            .map((record) => record.checkpointId as string);
          if (persistedIds.length > 0) {
            ids = [...new Set(persistedIds)];
          }
        } catch {
          // 使用已缓存的消息顺序，避免历史读取失败时隐藏面板内容。
        }
      }
      if (ids.length === 0 && baselineCheckpointId) {
        ids = [baselineCheckpointId];
      }
      if (ids.length === 0) {
        if (!cancelled) {
          setCheckpointState({ requestKey, diffs: null });
        }
        return;
      }

      try {
        // includeAll=true: 后续会话在共享工作区中的修改不会隐藏较早会话
        // 的变更，批量 API 还会覆盖每个消息检查点记录的文件。
        const diffs = await window.snow.listCheckpointDiffsBatch(
          ids,
          workDir,
          true
        );
        if (!cancelled) {
          setCheckpointState({ requestKey, diffs });
        }
      } catch {
        if (!cancelled) {
          setCheckpointState({ requestKey, diffs: null });
        }
      }
    };

    void loadCheckpointDiffs();

    return () => {
      cancelled = true;
    };
  }, [
    baselineCheckpointId,
    canUseCheckpoint,
    completedToolSignature,
    conversationId,
    conversationVersion,
    orderedCheckpointIds,
    requestKey,
    workDir,
  ]);

  return useMemo(() => {
    if (
      !canUseCheckpoint ||
      checkpointState.requestKey !== requestKey ||
      checkpointState.diffs === null
    ) {
      return fallbackChanges;
    }

    const checkpointChanges: FileChangeRecord[] = checkpointState.diffs.map(
      (diff, index) => {
        const fallback = findFallbackChange(diff.path, fallbackChanges);
        return {
          filePath: diff.path,
          kind: toFileChangeKind(diff.changeType),
          agent: fallback?.agent ?? "main",
          subAgentName: fallback?.subAgentName,
          timestamp: fallback?.timestamp ?? index,
          diff: {
            patch: diff.content,
            isBinary: diff.isBinary,
          },
        };
      }
    );

    // A successful but empty checkpoint result is ambiguous: the baseline
    // checkpoint may have been deleted (rollback, compaction cleanup,
    // new-chat pruning) — listCheckpointDiffs returns an empty list for
    // missing manifests instead of an error. Also, tool-recorded changes for
    // files the checkpoint never captured (capture failures, SSH fallbacks)
    // are absent from the checkpoint view. Append those fallback records so
    // the panel never loses tool-recorded modifications; checkpoint diffs
    // keep precedence for files covered by both sources.
    const checkpointPaths = new Set(
      checkpointChanges.map((change) => normalizePath(change.filePath))
    );
    const missingFallback = fallbackChanges.filter(
      (change) => !checkpointPaths.has(normalizePath(change.filePath))
    );
    return [...checkpointChanges, ...missingFallback].sort(
      (left, right) => left.timestamp - right.timestamp
    );
  }, [
    canUseCheckpoint,
    checkpointState,
    fallbackChanges,
    requestKey,
  ]);
};
