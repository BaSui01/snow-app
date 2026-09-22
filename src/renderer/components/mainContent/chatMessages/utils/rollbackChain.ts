import type {
  ChatConversationMessage,
  ChatMessageRecord,
  ToolCallInfo,
} from "./conversationTypes";
import { parseToolCalls } from "./conversationHelpers";

/** flow 级检查点的级联影响：回滚预览与文件变更面板共用同一份口径。 */
export type WorkflowFlowImpact = {
  flowCount: number;
  nodeConversationIds: string[];
  flowCheckpointIds: string[];
};

const EMPTY_IMPACT: WorkflowFlowImpact = {
  flowCount: 0,
  nodeConversationIds: [],
  flowCheckpointIds: [],
};

const collectFlowIds = (toolCalls: Iterable<ToolCallInfo>): string[] => {
  const flowIds: string[] = [];
  for (const toolCall of toolCalls) {
    if (
      toolCall.name.endsWith("workflow-generate") &&
      toolCall.interactionId &&
      !flowIds.includes(toolCall.interactionId)
    ) {
      flowIds.push(toolCall.interactionId);
    }
  }
  return flowIds;
};

/** 内存消息里的 workflow-generate flow id。 */
export const collectWorkflowFlowIdsFromMessages = (
  messages: ChatConversationMessage[],
): string[] =>
  collectFlowIds(messages.flatMap((message) => message.toolCalls ?? []));

/** 持久化记录里的 workflow-generate flow id（解析逻辑与运行时一致）。 */
export const collectWorkflowFlowIdsFromRecords = (
  records: ChatMessageRecord[],
): string[] =>
  collectFlowIds(
    records
      .filter((record) => record.role === "assistant")
      .flatMap((record) => parseToolCalls(record.toolCallsJson)),
  );

/**
 * flow id → 节点会话 / flow 检查点：flowIds 为 null 时取该会话全部节点会话
 * （文件变更面板覆盖整条会话），否则只保留给定 flow（回滚按截断边界过滤）。
 */
export const resolveWorkflowFlowImpact = async (
  conversationId: string,
  flowIds: string[] | null,
): Promise<WorkflowFlowImpact> => {
  try {
    const records = await window.snow.listWorkflowNodeSessions(conversationId);
    const affected = flowIds
      ? records.filter((record) => flowIds.includes(record.flowId))
      : records;
    return {
      flowCount: new Set(affected.map((record) => record.flowId)).size,
      nodeConversationIds: [
        ...new Set(affected.map((record) => record.conversationId)),
      ],
      flowCheckpointIds: [
        ...new Set(
          affected.map((record) => record.flowCheckpointId).filter(Boolean),
        ),
      ],
    };
  } catch {
    return EMPTY_IMPACT;
  }
};
