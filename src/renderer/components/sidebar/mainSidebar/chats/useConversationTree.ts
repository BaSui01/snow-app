import { useCallback, useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";

import type { ChatConversationRecord } from "../../../../../preload";
import type { SubAgentSessionEvent } from "../../../mainContent/chatMessages/utils/conversationTypes";

type SubAgentMap = Record<string, ChatConversationRecord[]>;

type UseConversationTreeOptions = {
  conversationsRef: RefObject<ChatConversationRecord[]>;
  conversationIdsKey: string;
  conversationListVersion: number;
  upsertedConversationTimestamp?: number;
  subAgentSessionEvents: Record<string, SubAgentSessionEvent>;
  activeConversationId: string | undefined;
  attentionRequiredConversationIds: Set<string>;
  runningConversationIds: Set<string>;
};

export function useConversationTree({
  conversationsRef,
  conversationIdsKey,
  conversationListVersion,
  upsertedConversationTimestamp,
  subAgentSessionEvents,
  activeConversationId,
  attentionRequiredConversationIds,
  runningConversationIds,
}: UseConversationTreeOptions) {
  const [subAgentMap, setSubAgentMap] = useState<SubAgentMap>({});
  // Workflow 主会话 -> 其 workflow 节点会话（树形子层）
  const [workflowNodeMap, setWorkflowNodeMap] = useState<SubAgentMap>({});
  const [expandedSubAgentConversationIds, setExpandedSubAgentConversationIds] =
    useState<Set<string>>(() => new Set());
  // 已展开的 Workflow 主会话（显示节点树）与已展开的节点会话（显示其子代理）
  const [expandedWorkflowConversationIds, setExpandedWorkflowConversationIds] =
    useState<Set<string>>(() => new Set());
  const [
    expandedWorkflowNodeConversationIds,
    setExpandedWorkflowNodeConversationIds,
  ] = useState<Set<string>>(() => new Set());

  // workflow 节点会话 id 集合的稳定 key：节点创建/更新时触发子代理重查
  const workflowNodeIdsKey = useMemo(() => {
    const ids: string[] = [];
    for (const nodes of Object.values(workflowNodeMap)) {
      for (const node of nodes) {
        ids.push(node.conversationId);
      }
    }
    return ids.join("\u0000");
  }, [workflowNodeMap]);

  // 含待确认子代理的父会话也视为需关注：与运行中会话一样置顶排序，
  // 保证会话较多时用户不会漏掉被暂停等待确认的子代理
  const surfacedConversationIds = useMemo(() => {
    if (attentionRequiredConversationIds.size === 0) {
      return runningConversationIds;
    }
    const next = new Set(runningConversationIds);
    for (const [parentId, subs] of Object.entries(subAgentMap)) {
      if (
        subs.some((sub) =>
          attentionRequiredConversationIds.has(sub.conversationId),
        )
      ) {
        // 子代理挂在 workflow 节点会话下时，需要继续提升到
        // workflow 主会话（树形层级：Workflow → 节点 → 子代理）
        const workflowParentId = Object.keys(workflowNodeMap).find(
          (workflowId) =>
            (workflowNodeMap[workflowId] ?? []).some(
              (node) => node.conversationId === parentId,
            ),
        );
        next.add(workflowParentId ?? parentId);
      }
    }
    // workflow 节点本身需关注时提升其主会话置顶
    for (const [parentId, nodes] of Object.entries(workflowNodeMap)) {
      if (
        nodes.some((node) =>
          attentionRequiredConversationIds.has(node.conversationId),
        )
      ) {
        next.add(parentId);
      }
    }
    return next;
  }, [
    runningConversationIds,
    attentionRequiredConversationIds,
    subAgentMap,
    workflowNodeMap,
  ]);

  /** 收集会话及其全部树形子层（子代理、workflow 节点、节点派生的子代理）的 id，
   *  用于删除/归档时中止流、清理草稿与判断活动会话。 */
  const collectConversationTreeIds = useCallback(
    (conversationId: string): string[] => {
      const ids = [conversationId];
      for (const sub of subAgentMap[conversationId] ?? []) {
        ids.push(sub.conversationId);
      }
      for (const node of workflowNodeMap[conversationId] ?? []) {
        ids.push(node.conversationId);
        for (const sub of subAgentMap[node.conversationId] ?? []) {
          ids.push(sub.conversationId);
        }
      }
      return ids;
    },
    [subAgentMap, workflowNodeMap],
  );

  // 加载所有主会话的 workflow 节点会话（树形子层）。
  // 依赖 conversationListVersion：workflow 节点创建/状态更新时会话记录
  // upsert 使版本递增，从而刷新节点树；conversationIdsKey 负责列表切换。
  useEffect(() => {
    const current = conversationsRef.current;
    if (current.length === 0) {
      setWorkflowNodeMap({});
      return;
    }

    let cancelled = false;

    const loadWorkflowNodes = async (): Promise<void> => {
      try {
        const map = await window.snow.listWorkflowNodeSessionsByParents(
          current.map((conv) => conv.conversationId),
        );
        if (!cancelled) {
          setWorkflowNodeMap(map);
        }
      } catch {
        if (!cancelled) {
          setWorkflowNodeMap({});
        }
      }
    };

    void loadWorkflowNodes();

    return () => {
      cancelled = true;
    };
  }, [
    conversationIdsKey,
    conversationListVersion,
    // 节点会话创建/更新时主动 upsert（workflowRunner），据此重查节点树
    upsertedConversationTimestamp,
    conversationsRef,
  ]);

  // 加载子代理：父级范围覆盖主会话与 workflow 节点会话（层级：
  // Workflow 主会话 → 节点会话 → 子代理），单次批量查询避免 N+1。
  useEffect(() => {
    const current = conversationsRef.current;
    const nodeIds = workflowNodeIdsKey
      ? workflowNodeIdsKey.split("\u0000")
      : [];
    const parentIds = [
      ...current.map((conv) => conv.conversationId),
      ...nodeIds,
    ];
    if (parentIds.length === 0) {
      setSubAgentMap({});
      return;
    }

    let cancelled = false;

    const loadSubAgents = async (): Promise<void> => {
      try {
        const map =
          await window.snow.listSubAgentConversationsByParents(parentIds);
        if (!cancelled) {
          setSubAgentMap(map);
        }
      } catch {
        if (!cancelled) {
          setSubAgentMap({});
        }
      }
    };

    void loadSubAgents();

    return () => {
      cancelled = true;
    };
  }, [
    conversationIdsKey,
    workflowNodeIdsKey,
    conversationListVersion,
    conversationsRef,
  ]);

  useEffect(() => {
    const events = Object.values(subAgentSessionEvents);
    if (events.length === 0) {
      return;
    }

    setSubAgentMap((prev) => {
      let next = prev;
      for (const event of events) {
        const {
          parentConversationId,
          conversationId,
          agentName,
          summary,
          status,
        } = event;

        const existing = next[parentConversationId] ?? [];
        const existingIndex = existing.findIndex(
          (item) => item.conversationId === conversationId,
        );

        const subAgentRecord: ChatConversationRecord = {
          conversationId,
          title: summary || agentName,
          summary,
          lastMessagePreview: "",
          messageCount: 0,
          model: "",
          apiProfileName: "",
          status: "active",
          directoryId: "",
          forkedFromConversationId: "",
          forkMessageCount: 0,
          conversationType: "sub_agent",
          parentConversationId,
          subAgentId: event.agentId,
          subAgentName: agentName,
          subAgentStatus: status,
          subAgentError: "",
          createdAt: new Date(event.timestamp).toISOString(),
          updatedAt: new Date(event.timestamp).toISOString(),
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalDurationMs: 0,
          runInputTokens: 0,
          runOutputTokens: 0,
          runCacheCreationInputTokens: 0,
          runCacheReadInputTokens: 0,
          lastRunDurationMs: 0,
          runTtftSumMs: 0,
          runRequestCount: 0,
          emoji: "",
        };

        if (existingIndex >= 0) {
          const updated = [...existing];
          updated[existingIndex] = {
            ...updated[existingIndex],
            subAgentStatus: status,
            subAgentName: agentName,
          };
          next = { ...next, [parentConversationId]: updated };
        } else {
          next = {
            ...next,
            [parentConversationId]: [...existing, subAgentRecord],
          };
        }
      }
      return next;
    });
  }, [subAgentSessionEvents]);

  // 当激活的会话是某个父会话的子代理时，自动展开该父会话的面板；
  // 激活的会话是 workflow 节点或其子代理时，自动展开对应 workflow 主会话
  // 与节点面板，保证层级可见。
  useEffect(() => {
    if (!activeConversationId) {
      return;
    }
    setExpandedSubAgentConversationIds((prev) => {
      const parentIds = Object.keys(subAgentMap).filter((parentId) =>
        subAgentMap[parentId].some(
          (sub) => sub.conversationId === activeConversationId,
        ),
      );
      if (parentIds.length === 0) {
        return prev;
      }
      const next = new Set(prev);
      for (const parentId of parentIds) {
        next.add(parentId);
      }
      return next;
    });
    setExpandedWorkflowConversationIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const [parentId, nodes] of Object.entries(workflowNodeMap)) {
        const isNodeActive = nodes.some(
          (node) => node.conversationId === activeConversationId,
        );
        const isNodeSubAgentActive = nodes.some((node) =>
          (subAgentMap[node.conversationId] ?? []).some(
            (sub) => sub.conversationId === activeConversationId,
          ),
        );
        if (isNodeActive) {
          if (!next.has(parentId)) {
            next.add(parentId);
            changed = true;
          }
          // 激活节点自身时也展开该节点的子代理面板
          setExpandedWorkflowNodeConversationIds((nodePrev) => {
            const nodeNext = new Set(nodePrev);
            if (isNodeActive && !nodeNext.has(activeConversationId as string)) {
              nodeNext.add(activeConversationId as string);
              return nodeNext;
            }
            return nodePrev;
          });
        } else if (isNodeSubAgentActive) {
          if (!next.has(parentId)) {
            next.add(parentId);
            changed = true;
          }
          for (const node of nodes) {
            if (
              (subAgentMap[node.conversationId] ?? []).some(
                (sub) => sub.conversationId === activeConversationId,
              )
            ) {
              setExpandedWorkflowNodeConversationIds((nodePrev) => {
                const nodeNext = new Set(nodePrev);
                if (!nodeNext.has(node.conversationId)) {
                  nodeNext.add(node.conversationId);
                  return nodeNext;
                }
                return nodePrev;
              });
            }
          }
        }
      }
      return changed ? next : prev;
    });
  }, [subAgentMap, workflowNodeMap, activeConversationId]);

  const handleToggleSubAgentPanel = (conversationId: string): void => {
    setExpandedSubAgentConversationIds((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
  };

  /** 展开/收起 Workflow 主会话的节点树 */
  const handleToggleWorkflowPanel = (conversationId: string): void => {
    setExpandedWorkflowConversationIds((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
  };

  /** 展开/收起 Workflow 节点会话的子代理列表 */
  const handleToggleWorkflowNode = (conversationId: string): void => {
    setExpandedWorkflowNodeConversationIds((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
  };

  return {
    subAgentMap,
    workflowNodeMap,
    surfacedConversationIds,
    collectConversationTreeIds,
    expandedSubAgentConversationIds,
    expandedWorkflowConversationIds,
    expandedWorkflowNodeConversationIds,
    handleToggleSubAgentPanel,
    handleToggleWorkflowPanel,
    handleToggleWorkflowNode,
  };
}
