import { Fragment, memo, useCallback } from "react";

import type { ChatConversationRecord } from "../../../../../preload";
import { ChatItem } from "../ChatItem";
import type { ExportFormat } from "../ChatItemMenu";
import { LazyCollapse } from "../LazyCollapse";
import { SubAgentListPanel } from "../SubAgentListPanel";
import { WorkflowNodeListPanel } from "../WorkflowNodeListPanel";
import { isPendingSessionKey } from "../../../mainContent/chatMessages/utils/conversationTypes";

/** 空列表常量：避免"没有子代理/节点"时每次渲染新建空数组，击穿本行的 memo。 */
export const EMPTY_CONVERSATION_LIST: ChatConversationRecord[] = [];

type ChatConversationRowProps = {
  conversation: ChatConversationRecord;
  /** 该行是否为当前打开的会话（由列表侧算好）。切换会话时只有它变化，
   *  因此整行可以 memo：切换只重渲染受影响的两行，而不是整张列表。 */
  isActive: boolean;
  streamingConversationIds: Set<string>;
  attentionRequiredConversationIds: Set<string>;
  completedConversationIds: Set<string>;
  runningConversationIds: Set<string>;
  surfacedConversationIds: Set<string>;
  pausedConversationIds: Set<string>;
  subAgentConversations: ChatConversationRecord[];
  workflowNodeConversations: ChatConversationRecord[];
  subAgentMap: Record<string, ChatConversationRecord[]>;
  expandedWorkflowNodeConversationIds: Set<string>;
  isTreeExpanded: boolean;
  isMultiSelectMode: boolean;
  isSelected: boolean;
  isArchiving: boolean;
  isDeleting: boolean;
  showPinBadge?: boolean;
  /** 以下回调都接收会话对象本身（引用稳定，不随每次渲染重建），
   *  行内再把它们绑定到本行的会话上。 */
  onSelectConversation: (conversation: ChatConversationRecord) => void;
  onSelectChildConversation: (
    conversationId: string,
    directoryId: string,
  ) => void;
  onToggleSelect: (conversationId: string) => void;
  onEnterMultiSelect?: () => void;
  onToggleTree: (conversationId: string) => void;
  onToggleWorkflowNode: (conversationId: string) => void;
  onPin: (conversation: ChatConversationRecord) => void;
  onUnpin: (conversation: ChatConversationRecord) => void;
  onRename: (
    conversation: ChatConversationRecord,
    newTitle: string,
  ) => Promise<void>;
  onSetEmoji: (
    conversation: ChatConversationRecord,
    emoji: string,
  ) => Promise<void>;
  onDelete: (
    conversation: ChatConversationRecord,
    deleteImages: boolean,
    deleteMemories: boolean,
  ) => void;
  onExport: (
    conversation: ChatConversationRecord,
    format: ExportFormat,
  ) => void;
  onFork: (conversation: ChatConversationRecord) => void;
  onArchive?: (conversation: ChatConversationRecord) => void;
};

export const ChatConversationRow = memo(function ChatConversationRow({
  conversation,
  isActive,
  streamingConversationIds,
  attentionRequiredConversationIds,
  completedConversationIds,
  runningConversationIds,
  surfacedConversationIds,
  pausedConversationIds,
  subAgentConversations,
  workflowNodeConversations,
  subAgentMap,
  expandedWorkflowNodeConversationIds,
  isTreeExpanded,
  isMultiSelectMode,
  isSelected,
  isArchiving,
  isDeleting,
  showPinBadge = false,
  onSelectConversation,
  onSelectChildConversation,
  onToggleSelect,
  onEnterMultiSelect,
  onToggleTree,
  onToggleWorkflowNode,
  onPin,
  onUnpin,
  onRename,
  onSetEmoji,
  onDelete,
  onExport,
  onFork,
  onArchive,
}: ChatConversationRowProps): React.JSX.Element {
  const conversationId = conversation.conversationId;
  const isWorkflow = workflowNodeConversations.length > 0;
  const hasTreeChildren = isWorkflow || subAgentConversations.length > 0;

  const handleSelect = useCallback((): void => {
    onSelectConversation(conversation);
  }, [conversation, onSelectConversation]);
  const handleToggleSelect = useCallback((): void => {
    onToggleSelect(conversationId);
  }, [conversationId, onToggleSelect]);
  const handleToggleTree = useCallback((): void => {
    onToggleTree(conversationId);
  }, [conversationId, onToggleTree]);
  const handlePin = useCallback((): void => {
    if (conversation.status === "pin") {
      onUnpin(conversation);
      return;
    }
    onPin(conversation);
  }, [conversation, onPin, onUnpin]);
  const handleRename = useCallback(
    (newTitle: string): Promise<void> => onRename(conversation, newTitle),
    [conversation, onRename],
  );
  const handleSetEmoji = useCallback(
    (emoji: string): Promise<void> => onSetEmoji(conversation, emoji),
    [conversation, onSetEmoji],
  );
  const handleDelete = useCallback(
    (deleteImages: boolean, deleteMemories: boolean): void =>
      onDelete(conversation, deleteImages, deleteMemories),
    [conversation, onDelete],
  );
  const handleExport = useCallback(
    (format: ExportFormat): void => onExport(conversation, format),
    [conversation, onExport],
  );
  const handleFork = useCallback((): void => {
    onFork(conversation);
  }, [conversation, onFork]);
  const handleArchive = useCallback((): void => {
    onArchive?.(conversation);
  }, [conversation, onArchive]);
  const handleSelectChild = useCallback(
    (childConversationId: string): void => {
      onSelectChildConversation(childConversationId, conversation.directoryId);
    },
    [conversation.directoryId, onSelectChildConversation],
  );

  return (
    <Fragment>
      <ChatItem
        conversation={conversation}
        isDraggable={!isPendingSessionKey(conversationId)}
        isActive={isActive}
        isAttentionRequired={attentionRequiredConversationIds.has(
          conversationId,
        )}
        isStreaming={streamingConversationIds.has(conversationId)}
        isPaused={pausedConversationIds.has(conversationId)}
        isCompleted={completedConversationIds.has(conversationId)}
        isRunning={
          runningConversationIds.has(conversationId) ||
          surfacedConversationIds.has(conversationId)
        }
        showPinBadge={showPinBadge}
        subAgentConversations={subAgentConversations}
        subAgentAttentionRequiredIds={attentionRequiredConversationIds}
        isWorkflow={isWorkflow}
        isTreeExpanded={isTreeExpanded}
        onToggleTree={handleToggleTree}
        isMultiSelectMode={isMultiSelectMode}
        isSelected={isSelected}
        onToggleSelect={handleToggleSelect}
        onEnterMultiSelect={onEnterMultiSelect}
        onPin={handlePin}
        onRename={handleRename}
        onSetEmoji={handleSetEmoji}
        onDelete={handleDelete}
        onExport={handleExport}
        onFork={handleFork}
        isArchiving={isArchiving}
        isDeleting={isDeleting}
        onArchive={conversation.status === "pin" ? undefined : handleArchive}
        onSelect={handleSelect}
      />
      {/* 面板渲染在 ChatItem 外部，作为兄弟节点，
          完全不继承父级会话项的背景色。
          Workflow 节点树与子代理列表共用一个折叠容器：两者由同一个
          展开按钮控制，共用容器后展开时只出现一个 loading 占位 */}
      <LazyCollapse
        open={hasTreeChildren && isTreeExpanded && !isMultiSelectMode}
        renderContent={() => (
          <>
            {isWorkflow ? (
              <WorkflowNodeListPanel
                conversations={workflowNodeConversations}
                attentionRequiredConversationIds={
                  attentionRequiredConversationIds
                }
                streamingConversationIds={streamingConversationIds}
                subAgentMap={subAgentMap}
                expandedNodeIds={expandedWorkflowNodeConversationIds}
                onToggleNode={onToggleWorkflowNode}
                onSelect={handleSelectChild}
              />
            ) : null}
            {subAgentConversations.length > 0 ? (
              <SubAgentListPanel
                conversations={subAgentConversations}
                attentionRequiredConversationIds={
                  attentionRequiredConversationIds
                }
                onSelect={handleSelectChild}
              />
            ) : null}
          </>
        )}
      />
    </Fragment>
  );
});
