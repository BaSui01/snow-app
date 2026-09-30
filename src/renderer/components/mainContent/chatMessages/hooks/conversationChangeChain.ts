import { resolveConversationWorkspacePath } from "../utils/conversationHelpers";
import { resolveWorkflowFlowImpact } from "../utils/rollbackChain";
import type { ChatConversationMessage } from "../utils/conversationTypes";

type ConversationChangeChainParams = {
  conversationId?: string;
  checkpointIds?: string[];
  baselineCheckpointId?: string;
  workDir?: string;
  messages: ChatConversationMessage[];
  worktreeMode?: boolean;
  worktreeId?: string | null;
  directoryId?: string;
};

/** 回滚链描述：检查点清单 + diff 基准目录。 */
export type ConversationChangeChain = {
  checkpointIds: string[];
  workDir: string;
};

/**
 * 回滚本会话时真正会恢复的文件对应整条检查点链：数据库持久化的消息检查点
 * （优先于内存缓存顺序）+ WorkFlow flow 检查点，再解析 worktree 下的真实
 * 工作目录。检查点链为空或读取失败时返回 null，调用方回退到工具记录统计。
 * 桌面 FileChangesPanel（useConversationFileChanges）与远控 /changes 面板共用。
 */
export const resolveConversationChangeChain = async ({
  conversationId,
  checkpointIds,
  baselineCheckpointId,
  workDir,
  messages,
  worktreeMode,
  worktreeId,
  directoryId,
}: ConversationChangeChainParams): Promise<ConversationChangeChain | null> => {
  if (!workDir) {
    return null;
  }

  let ids = [...new Set(checkpointIds ?? [])];
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
      // 历史读取失败时沿用已缓存的检查点顺序。
    }
  }
  if (ids.length === 0) {
    ids = messages
      .filter((message) => message.role === "user" && message.checkpointId)
      .map((message) => message.checkpointId as string);
  }
  if (ids.length === 0 && baselineCheckpointId) {
    ids = [baselineCheckpointId];
  }

  let flowCheckpointIds: string[] = [];
  if (conversationId) {
    flowCheckpointIds = (await resolveWorkflowFlowImpact(conversationId, null))
      .flowCheckpointIds;
  }
  const chainIds = [...new Set([...ids, ...flowCheckpointIds])];
  if (chainIds.length === 0) {
    return null;
  }

  let effectiveWorkDir = workDir;
  if (worktreeMode || worktreeId) {
    try {
      const resolved = await resolveConversationWorkspacePath(
        conversationId ?? "",
        directoryId,
        workDir,
        Boolean(worktreeMode),
        worktreeId,
      );
      if (resolved) {
        effectiveWorkDir = resolved;
      }
    } catch {
      // 解析失败时保留原工作目录。
    }
  }

  return { checkpointIds: chainIds, workDir: effectiveWorkDir };
};
