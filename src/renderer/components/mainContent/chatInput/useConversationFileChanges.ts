import { useEffect, useMemo, useState } from "react";
import type {
  ChatConversationMessage,
  FileChangeRecord,
} from "../chatMessages/utils/conversationTypes";
import { resolveWorkflowFlowImpact } from "../chatMessages/utils/rollbackChain";

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
  conversationKey: string;
  diffs: CheckpointDiffs | null;
};

const normalizePath = (filePath: string): string =>
  filePath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .toLowerCase();

const findFallbackChange = (
  checkpointPath: string,
  fallbackChanges: FileChangeRecord[],
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

const toFileChangeKind = (changeType: string): FileChangeRecord["kind"] => {
  if (changeType === "added") {
    return "create";
  }
  if (changeType === "deleted") {
    return "delete";
  }
  return "edit";
};

/**
 * 会话文件变更 = 回滚本会话时真正会恢复的文件：检查点链取整条会话（加上
 * WorkFlow 节点 flow 检查点），includeAll=false 与 rollback 弹窗完全一致。
 * 工具记录的统计只用于补齐代理归属，不再追加条目，保证两个入口列表一致；
 * 只有在检查点链不可用（无检查点、读取失败，如子代理会话）时才退回统计。
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
            `${toolCall.interactionId}:${toolCall.status}:${toolCall.result?.length ?? 0}`,
        )
        .join("|"),
    [messages],
  );

  const orderedCheckpointIds = useMemo(
    () => [...new Set(checkpointIds ?? [])],
    [checkpointIds],
  );
  const messageCheckpointIds = useMemo(
    () =>
      messages
        .filter((message) => message.role === "user" && message.checkpointId)
        .map((message) => message.checkpointId as string),
    [messages],
  );
  const canUseCheckpoint = Boolean(
    workDir &&
    (orderedCheckpointIds.length > 0 ||
      messageCheckpointIds.length > 0 ||
      baselineCheckpointId),
  );
  // 会话 + 工作区身份：同会话重算时沿用上一次结果，避免列表抖动。
  const conversationKey = `${conversationId ?? ""}|${workDir ?? ""}`;
  const checkpointRequestKey = useMemo(
    () =>
      JSON.stringify([
        conversationKey,
        orderedCheckpointIds,
        messageCheckpointIds,
        baselineCheckpointId ?? "",
        completedToolSignature,
        conversationVersion,
      ]),
    [
      baselineCheckpointId,
      completedToolSignature,
      conversationKey,
      conversationVersion,
      messageCheckpointIds,
      orderedCheckpointIds,
    ],
  );
  const [checkpointState, setCheckpointState] = useState<CheckpointDiffState>({
    conversationKey: "",
    diffs: null,
  });

  useEffect(() => {
    if (!canUseCheckpoint || !workDir) {
      return;
    }

    let cancelled = false;
    const loadCheckpointDiffs = async (): Promise<void> => {
      let ids = orderedCheckpointIds;
      if (conversationId) {
        try {
          const fullHistory =
            await window.snow.listChatMessages(conversationId);
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
      if (ids.length === 0) {
        ids = messageCheckpointIds;
      }
      if (ids.length === 0 && baselineCheckpointId) {
        ids = [baselineCheckpointId];
      }

      let flowCheckpointIds: string[] = [];
      if (conversationId) {
        flowCheckpointIds = (
          await resolveWorkflowFlowImpact(conversationId, null)
        ).flowCheckpointIds;
      }
      const chainIds = [...new Set([...ids, ...flowCheckpointIds])];
      if (chainIds.length === 0) {
        if (!cancelled) {
          setCheckpointState({ conversationKey, diffs: null });
        }
        return;
      }

      try {
        // includeAll=false：与回滚弹窗同一语义，只列出回滚真正会恢复的文件。
        const diffs = await window.snow.listCheckpointDiffsBatch(
          chainIds,
          workDir,
          false,
        );
        if (!cancelled) {
          setCheckpointState({ conversationKey, diffs });
        }
      } catch {
        if (!cancelled) {
          setCheckpointState({ conversationKey, diffs: null });
        }
      }
    };

    void loadCheckpointDiffs();

    return () => {
      cancelled = true;
    };
  }, [canUseCheckpoint, checkpointRequestKey, workDir]);

  return useMemo(() => {
    if (
      !canUseCheckpoint ||
      checkpointState.diffs === null ||
      checkpointState.conversationKey !== conversationKey
    ) {
      return fallbackChanges;
    }

    return checkpointState.diffs.map((diff, index) => {
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
    });
  }, [canUseCheckpoint, checkpointState, conversationKey, fallbackChanges]);
};
