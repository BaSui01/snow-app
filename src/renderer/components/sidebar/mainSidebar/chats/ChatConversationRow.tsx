import { Fragment } from "react";

import type { ChatConversationRecord } from "../../../../../preload";
import { ChatItem } from "../ChatItem";
import type { ExportFormat } from "../ChatItemMenu";
import { SidebarCollapse } from "../SidebarCollapse";
import { SubAgentListPanel } from "../SubAgentListPanel";
import { WorkflowNodeListPanel } from "../WorkflowNodeListPanel";
import { isPendingSessionKey } from "../../../mainContent/chatMessages/utils/conversationTypes";

type ChatConversationRowProps = {
  conversation: ChatConversationRecord;
  activeConversationId?: string;
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
  isSubAgentExpanded: boolean;
  isWorkflowPanelExpanded: boolean;
  isMultiSelectMode: boolean;
  isSelected: boolean;
  isArchiving: boolean;
  isDeleting: boolean;
  onSelectConversation: (conversation: ChatConversationRecord) => void;
  onSelectChildConversation: (
    conversationId: string,
    directoryId: string,
  ) => void;
  onToggleSelect: () => void;
  onEnterMultiSelect: () => void;
  onToggleSubAgentPanel: () => void;
  onToggleWorkflowPanel: () => void;
  onToggleWorkflowNode: (conversationId: string) => void;
  onPin: () => void;
  onRename: (newTitle: string) => Promise<void>;
  onSetEmoji: (emoji: string) => Promise<void>;
  onDelete: (deleteImages: boolean, deleteMemories: boolean) => void;
  onExport: (format: ExportFormat) => void;
  onFork: () => void;
  onArchive?: () => void;
};

export function ChatConversationRow({
  conversation,
  activeConversationId,
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
  isSubAgentExpanded,
  isWorkflowPanelExpanded,
  isMultiSelectMode,
  isSelected,
  isArchiving,
  isDeleting,
  onSelectConversation,
  onSelectChildConversation,
  onToggleSelect,
  onEnterMultiSelect,
  onToggleSubAgentPanel,
  onToggleWorkflowPanel,
  onToggleWorkflowNode,
  onPin,
  onRename,
  onSetEmoji,
  onDelete,
  onExport,
  onFork,
  onArchive,
}: ChatConversationRowProps): React.JSX.Element {
  const conversationId = conversation.conversationId;
  const isWorkflow = workflowNodeConversations.length > 0;

  return (
    <Fragment>
      <ChatItem
        conversation={conversation}
        isDraggable={!isPendingSessionKey(conversationId)}
        isActive={conversationId === activeConversationId}
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
        subAgentConversations={subAgentConversations}
        subAgentAttentionRequiredIds={attentionRequiredConversationIds}
        isSubAgentExpanded={isSubAgentExpanded}
        isWorkflow={isWorkflow}
        isWorkflowExpanded={isWorkflowPanelExpanded}
        onToggleWorkflowPanel={onToggleWorkflowPanel}
        isMultiSelectMode={isMultiSelectMode}
        isSelected={isSelected}
        onToggleSelect={onToggleSelect}
        onEnterMultiSelect={onEnterMultiSelect}
        onToggleSubAgentPanel={onToggleSubAgentPanel}
        onPin={onPin}
        onRename={onRename}
        onSetEmoji={onSetEmoji}
        onDelete={onDelete}
        onExport={onExport}
        onFork={onFork}
        isArchiving={isArchiving}
        isDeleting={isDeleting}
        onArchive={conversation.status === "pin" ? undefined : onArchive}
        onSelect={() => onSelectConversation(conversation)}
      />
      {/* 面板渲染在 ChatItem 外部，作为兄弟节点，
                          完全不继承父级会话项的背景色 */}
      <SidebarCollapse
        open={isWorkflow && isWorkflowPanelExpanded && !isMultiSelectMode}
      >
        <WorkflowNodeListPanel
          conversations={workflowNodeConversations}
          activeConversationId={activeConversationId}
          attentionRequiredConversationIds={attentionRequiredConversationIds}
          streamingConversationIds={streamingConversationIds}
          subAgentMap={subAgentMap}
          expandedNodeIds={expandedWorkflowNodeConversationIds}
          onToggleNode={onToggleWorkflowNode}
          onSelect={(nodeConvId) =>
            onSelectChildConversation(nodeConvId, conversation.directoryId)
          }
        />
      </SidebarCollapse>
      <SidebarCollapse
        open={
          subAgentConversations.length > 0 &&
          isSubAgentExpanded &&
          !isMultiSelectMode
        }
      >
        <SubAgentListPanel
          conversations={subAgentConversations}
          activeConversationId={activeConversationId}
          attentionRequiredConversationIds={attentionRequiredConversationIds}
          onSelect={(subConvId) =>
            onSelectChildConversation(subConvId, conversation.directoryId)
          }
        />
      </SidebarCollapse>
    </Fragment>
  );
}