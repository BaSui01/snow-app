import { Fragment, useMemo } from "react";
import type { RefObject } from "react";

import { Loader2 } from "lucide-react";

import type { ChatConversationRecord } from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import { useChatConversationContext } from "../../../mainContent/chatMessages";
import { ChatConversationRow } from "../chats/ChatConversationRow";
import { ChatListFooter } from "../chats/ChatListFooter";
import { useChatConversationList } from "../chats/useChatConversationList";
import { useConversationActions } from "../chats/useConversationActions";
import { useConversationTree } from "../chats/useConversationTree";
import { usePausedConversationIds } from "../chats/usePausedConversationIds";
import { usePinnedConversations } from "../chats/usePinnedConversations";

const EMPTY_SELECTED_IDS = new Set<string>();
const noop = (): void => undefined;

type TreeProjectChatsProps = {
  directoryId: string;
  activeDirectoryId?: string;
  activeConversationId?: string;
  sectionListRef: RefObject<HTMLDivElement | null>;
};

export function TreeProjectChats({
  directoryId,
  activeDirectoryId,
  activeConversationId,
  sectionListRef,
}: TreeProjectChatsProps): React.JSX.Element {
  const { t } = useI18n();
  const {
    conversationListVersion,
    upsertedConversation,
    pendingToRealConversationIdRef,
    subAgentSessionEvents,
    refreshConversations,
    updateConversationSummary,
    handleSelectConversation,
    handleForkConversation,
    handleNewChat,
    activeSessionKeyRef,
    abortConversation,
    sessions,
    streamingConversationIds,
    attentionRequiredConversationIds,
    completedConversationIds,
    clearInputDraft,
  } = useChatConversationContext();

  const runningConversationIds = useMemo(
    () =>
      new Set([
        ...streamingConversationIds,
        ...attentionRequiredConversationIds,
      ]),
    [streamingConversationIds, attentionRequiredConversationIds],
  );
  const pausedConversationIds = usePausedConversationIds(sessions);

  const list = useChatConversationList({
    directoryId,
    conversationListVersion,
    upsertedConversation,
    pendingToRealConversationIdRef,
    runningConversationIds,
    sessions,
    isCollapsed: false,
    sectionListRef,
  });

  const tree = useConversationTree({
    conversationsRef: list.conversationsRef,
    conversationIdsKey: list.conversationIdsKey,
    conversationListVersion,
    upsertedConversationTimestamp: upsertedConversation?.timestamp,
    subAgentSessionEvents,
    activeConversationId,
    attentionRequiredConversationIds,
    runningConversationIds,
  });

  const actions = useConversationActions({
    activeConversationId,
    selectedIds: EMPTY_SELECTED_IDS,
    resetMultiSelect: noop,
    collectConversationTreeIds: tree.collectConversationTreeIds,
    refreshConversations,
    updateConversationSummary,
    abortConversation,
    clearInputDraft,
    handleNewChat,
    handleForkConversation,
    setConversations: list.setConversations,
  });

  const pinned = usePinnedConversations({
    directoryId,
    conversationListVersion,
    upsertedConversation,
  });

  const handleSelectConversationFromList = (
    conversation: ChatConversationRecord,
  ): void => {
    void (async (): Promise<void> => {
      if (
        conversation.directoryId &&
        conversation.directoryId !== activeDirectoryId
      ) {
        try {
          await window.snow.activateWorkspaceDirectory(
            conversation.directoryId,
          );
        } catch {}
      }
      await handleSelectConversation(
        conversation.conversationId,
        conversation.summary || conversation.title,
        {
          inputTokens: conversation.inputTokens,
          outputTokens: conversation.outputTokens,
          cacheCreationInputTokens: conversation.cacheCreationInputTokens,
          cacheReadInputTokens: conversation.cacheReadInputTokens,
        },
        conversation.directoryId,
      );
    })();
  };

  const handleSelectChildConversation = (
    conversationId: string,
    childDirectoryId: string,
  ): void => {
    void (async (): Promise<void> => {
      if (childDirectoryId && childDirectoryId !== activeDirectoryId) {
        try {
          await window.snow.activateWorkspaceDirectory(childDirectoryId);
        } catch {}
      }
      await handleSelectConversation(
        conversationId,
        undefined,
        undefined,
        childDirectoryId,
      );
    })();
  };

  const renderConversationRow = (
    conversation: ChatConversationRecord,
  ): React.JSX.Element => {
    const conversationId = conversation.conversationId;
    const conversationKey = list.getConversationKey(conversation);
    const isActive =
      conversationId === activeConversationId ||
      conversationKey === activeSessionKeyRef.current ||
      (activeConversationId !== undefined &&
        pendingToRealConversationIdRef.current.get(conversationKey) ===
          activeConversationId);
    return (
      <ChatConversationRow
        activeConversationId={isActive ? conversationId : activeConversationId}
        attentionRequiredConversationIds={attentionRequiredConversationIds}
        completedConversationIds={completedConversationIds}
        conversation={conversation}
        expandedWorkflowNodeConversationIds={
          tree.expandedWorkflowNodeConversationIds
        }
        isArchiving={actions.archivingIds.has(conversationId)}
        isDeleting={actions.deletingIds.has(conversationId)}
        isMultiSelectMode={false}
        isSelected={false}
        isSubAgentExpanded={tree.expandedSubAgentConversationIds.has(
          conversationId,
        )}
        isWorkflowPanelExpanded={tree.expandedWorkflowConversationIds.has(
          conversationId,
        )}
        onArchive={() => void actions.handleArchive(conversation)}
        onDelete={(deleteImages, deleteMemories) =>
          void actions.handleDelete(conversation, deleteImages, deleteMemories)
        }
        onExport={(format) => void actions.handleExport(conversation, format)}
        onFork={() => actions.handleFork(conversation)}
        onPin={() =>
          void (conversation.status === "pin"
            ? actions.handleUnpin(conversation)
            : actions.handlePin(conversation))
        }
        onRename={(newTitle) => actions.handleRename(conversation, newTitle)}
        onSelectChildConversation={handleSelectChildConversation}
        onSelectConversation={handleSelectConversationFromList}
        onSetEmoji={(emoji) => actions.handleSetEmoji(conversation, emoji)}
        onToggleSelect={noop}
        onToggleSubAgentPanel={() =>
          tree.handleToggleSubAgentPanel(conversationId)
        }
        onToggleWorkflowNode={tree.handleToggleWorkflowNode}
        onToggleWorkflowPanel={() =>
          tree.handleToggleWorkflowPanel(conversationId)
        }
        pausedConversationIds={pausedConversationIds}
        runningConversationIds={runningConversationIds}
        showPinBadge
        streamingConversationIds={streamingConversationIds}
        subAgentConversations={tree.subAgentMap[conversationId] ?? []}
        subAgentMap={tree.subAgentMap}
        surfacedConversationIds={tree.surfacedConversationIds}
        workflowNodeConversations={tree.workflowNodeMap[conversationId] ?? []}
      />
    );
  };

  const showLoading = list.isLoading && list.conversations.length === 0;
  const isEmpty =
    !showLoading &&
    !list.error &&
    list.conversations.length === 0 &&
    pinned.pinnedConversations.length === 0;

  return (
    <>
      {showLoading ? (
        <span className="empty-text loading">
          <Loader2 className="spin" size={13} />
          {t("sidebar.loadingWorkspaceContent", {
            defaultValue: "Loading workspace content...",
          })}
        </span>
      ) : list.error ? (
        <span className="empty-text error">{list.error}</span>
      ) : isEmpty ? (
        <span className="empty-text">
          {t("sidebar.noChats", { defaultValue: "No chats" })}
        </span>
      ) : (
        <>
          {pinned.pinnedConversations.map((conversation) => (
            <Fragment key={list.getConversationKey(conversation)}>
              {renderConversationRow(conversation)}
            </Fragment>
          ))}
          {list.conversations.map((conversation) => (
            <Fragment key={list.getConversationKey(conversation)}>
              {renderConversationRow(conversation)}
            </Fragment>
          ))}
          <ChatListFooter
            hasMore={list.hasMore}
            isLoadingMore={list.isLoadingMore}
            sentinelRef={list.loadMoreRef}
          />
        </>
      )}
    </>
  );
}
