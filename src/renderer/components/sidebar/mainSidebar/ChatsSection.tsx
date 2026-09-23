import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";

import type {
  ChatConversationRecord,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { useChatConversationContext } from "../../mainContent/chatMessages";
import { groupConversationsByTime, type TimeGroup } from "./chatTimeGroup";
import { ArchivedChatList } from "./chats/ArchivedChatList";
import { ChatConversationRow } from "./chats/ChatConversationRow";
import { ChatListFooter } from "./chats/ChatListFooter";
import {
  ChatMultiSelectBar,
  type ChatMultiSelectAction,
} from "./chats/ChatMultiSelectBar";
import { ChatTimeGroupList } from "./chats/ChatTimeGroupList";
import { ChatImportProgress } from "./chats/ChatImportProgress";
import { ChatsSectionDialogs } from "./chats/ChatsSectionDialogs";
import { ChatsSectionHeader } from "./chats/ChatsSectionHeader";
import { CrossProjectNotificationList } from "./chats/CrossProjectNotificationList";
import { useArchivedConversations } from "./chats/useArchivedConversations";
import { useChatConversationList } from "./chats/useChatConversationList";
import { useChatImport } from "./chats/useChatImport";
import { useChatSelection } from "./chats/useChatSelection";
import {
  useChatsCollapse,
  useChatsSectionLayout,
} from "./chats/useChatsSectionLayout";
import { useConversationActions } from "./chats/useConversationActions";
import { useConversationTree } from "./chats/useConversationTree";
import { usePinnedConversations } from "./chats/usePinnedConversations";
import { useChatsSectionInteractions } from "./chats/useChatsSectionInteractions";
import type { CrossProjectNotificationGroup } from "./useCrossProjectNotifications";

type ChatsSectionProps = {
  isSwitchingDirectory: boolean;
  activeDirectory?: WorkspaceDirectoryRecord | null;
  /** 跨项目通知（其他项目的运行中/需关注/已完成会话分组） */
  crossProjectNotifications: CrossProjectNotificationGroup[];
  /** 收起状态变化时上报父组件（收起后剩余高度让给项目区域） */
  onCollapsedChange?: (collapsed: boolean) => void;
};

export function ChatsSection({
  isSwitchingDirectory,
  activeDirectory,
  crossProjectNotifications,
  onCollapsedChange,
}: ChatsSectionProps): React.JSX.Element {
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
    activeConversationId,
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
  // 被用户暂停的流式会话（agent loop 阻塞等待恢复），图标切换为暂停态。
  // sessions 每个流式帧都会换引用：内容不变时复用上一份 Set，避免下游
  // （会话列表/树/选择态）因引用抖动而整片重算。
  const pausedConversationIdsRef = useRef<Set<string>>(new Set());
  const pausedConversationIds = useMemo(() => {
    const next = new Set<string>();
    for (const [id, session] of Object.entries(sessions)) {
      if (session.isPaused) {
        next.add(id);
      }
    }
    const previous = pausedConversationIdsRef.current;
    if (previous.size === next.size) {
      let same = true;
      for (const id of next) {
        if (!previous.has(id)) {
          same = false;
          break;
        }
      }
      if (same) {
        return previous;
      }
    }
    pausedConversationIdsRef.current = next;
    return next;
  }, [sessions]);

  const directoryId = activeDirectory?.directoryId ?? "";
  const sectionListRef = useRef<HTMLDivElement | null>(null);
  const collapse = useChatsCollapse({ onCollapsedChange });

  const pinned = usePinnedConversations({
    directoryId,
    conversationListVersion,
    upsertedConversation,
  });

  const list = useChatConversationList({
    directoryId,
    conversationListVersion,
    upsertedConversation,
    pendingToRealConversationIdRef,
    runningConversationIds,
    sessions,
    isCollapsed: collapse.isCollapsed,
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

  const selection = useChatSelection({
    conversations: list.conversations,
    runningConversationIds,
    surfacedConversationIds: tree.surfacedConversationIds,
  });

  const actions = useConversationActions({
    activeConversationId,
    selectedIds: selection.selectedIds,
    resetMultiSelect: selection.resetMultiSelect,
    collectConversationTreeIds: tree.collectConversationTreeIds,
    refreshConversations,
    updateConversationSummary,
    abortConversation,
    clearInputDraft,
    handleNewChat,
    handleForkConversation,
    setConversations: list.setConversations,
  });

  const exitMultiSelect = useCallback((): void => {
    if (actions.isActionLocked) {
      return;
    }
    selection.exitMultiSelect();
    actions.setShowBatchConfirm(false);
  }, [actions, selection]);

  const layout = useChatsSectionLayout({
    isMultiSelectMode: selection.isMultiSelectMode,
  });

  const archived = useArchivedConversations({
    directoryId,
    isCollapsed: collapse.isCollapsed,
    sectionListRef,
    refreshConversations,
    onExitChatMultiSelect: exitMultiSelect,
  });

  const chatImport = useChatImport({
    directoryId,
    refreshConversations,
  });

  /** 收起/展开会话区域；收起时退出多选模式 */
  const toggleCollapsed = (): void => {
    collapse.setCollapsedPersisted(!collapse.isCollapsed);
    if (selection.isMultiSelectMode) {
      exitMultiSelect();
    }
    if (archived.isArchivedMultiSelect) {
      archived.handleExitArchivedMultiSelect();
    }
  };

  const interactions = useChatsSectionInteractions({
    isArchiveMode: archived.isArchiveMode,
    setIsChatDragOver: layout.setIsChatDragOver,
    refreshConversations,
    handleSelectConversation,
  });
  const {
    handleOpenCrossProjectNotification,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePinnedDragOver,
    handlePinnedDragLeave,
    handlePinnedDrop,
    isPinnedDragOver,
    handleSelectConversationFromList,
    handleSelectChildConversation,
  } = interactions;

  const timeGroups = groupConversationsByTime(
    list.conversations,
    new Date(),
    tree.surfacedConversationIds,
  );
  // 运行中会话分组排在最前，随列表一起滚动（不再固定在列表头部）
  const runningGroup = timeGroups.find((group) => group.key === "running");
  const contentGroups = timeGroups.filter((group) => group.key !== "running");
  // 置顶会话在会话列表内单独成组（随列表滚动），行内以 Pin 图标标注
  const pinnedGroups: TimeGroup[] =
    pinned.pinnedConversations.length > 0
      ? [{ key: "pinned", conversations: pinned.pinnedConversations }]
      : [];

  const showLoading =
    isSwitchingDirectory || (list.isLoading && directoryId !== "");

  // 多选模式下会话列表按选择集合渲染，置顶分组临时隐藏避免不可选条目干扰
  const showPinnedGroup =
    !archived.isArchiveMode &&
    !collapse.isCollapsed &&
    !showLoading &&
    directoryId !== "" &&
    !list.error &&
    !selection.isMultiSelectMode;

  const allSelected =
    selection.selectedIds.size === selection.multiSelectableCount;

  const multiSelectActions: ChatMultiSelectAction[] = [
    {
      key: "archive",
      label:
        actions.archivingIds.size > 0
          ? t("sidebar.chatMultiSelectArchiving", {
              defaultValue: "Archiving...",
            })
          : t("sidebar.chatMultiSelectArchive", {
              defaultValue: "Archive selected",
            }),
      icon: actions.archivingIds.size > 0 ? "spinner" : "archive",
      disabled:
        actions.archivingIds.size > 0 || selection.selectedIds.size === 0,
      onClick: () => void actions.handleBatchArchive(),
    },
    {
      key: "delete",
      label: actions.isBatchDeleting
        ? t("sidebar.chatMultiSelectDeleting", {
            defaultValue: "Deleting...",
          })
        : t("sidebar.chatMultiSelectDelete", {
            defaultValue: "Delete selected",
          }),
      icon: actions.isBatchDeleting ? "spinner" : "trash",
      disabled:
        actions.isBatchDeleting ||
        actions.archivingIds.size > 0 ||
        selection.selectedIds.size === 0,
      danger: true,
      onClick: actions.handleOpenBatchConfirm,
    },
  ];

  const renderConversationRow = (
    conversation: ChatConversationRecord,
  ): React.JSX.Element => {
    const conversationId = conversation.conversationId;
    return (
      <ChatConversationRow
        activeConversationId={activeConversationId}
        attentionRequiredConversationIds={attentionRequiredConversationIds}
        completedConversationIds={completedConversationIds}
        conversation={conversation}
        expandedWorkflowNodeConversationIds={
          tree.expandedWorkflowNodeConversationIds
        }
        isArchiving={actions.archivingIds.has(conversationId)}
        isDeleting={actions.deletingIds.has(conversationId)}
        isMultiSelectMode={selection.isMultiSelectMode}
        isSelected={selection.selectedIds.has(conversationId)}
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
        onEnterMultiSelect={selection.enterMultiSelect}
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
        onToggleSelect={() => selection.handleToggleSelect(conversationId)}
        onToggleSubAgentPanel={() =>
          tree.handleToggleSubAgentPanel(conversationId)
        }
        onToggleWorkflowNode={tree.handleToggleWorkflowNode}
        onToggleWorkflowPanel={() =>
          tree.handleToggleWorkflowPanel(conversationId)
        }
        pausedConversationIds={pausedConversationIds}
        runningConversationIds={runningConversationIds}
        streamingConversationIds={streamingConversationIds}
        subAgentConversations={tree.subAgentMap[conversationId] ?? []}
        subAgentMap={tree.subAgentMap}
        surfacedConversationIds={tree.surfacedConversationIds}
        workflowNodeConversations={tree.workflowNodeMap[conversationId] ?? []}
      />
    );
  };

  return (
    <div
      className={`sidebar-section chats-section${
        collapse.isCollapsed ? " collapsed" : ""
      }`}
      ref={layout.sectionRef}
    >
      {selection.isMultiSelectMode ? (
        <ChatMultiSelectBar
          actions={multiSelectActions}
          allSelected={allSelected}
          headerRef={layout.headerRef}
          isExitDisabled={actions.isActionLocked}
          onExit={exitMultiSelect}
          onToggleSelectAll={
            allSelected
              ? selection.handleDeselectAll
              : selection.handleSelectAll
          }
          selectAllDisabled={actions.isActionLocked}
          selectedCount={selection.selectedIds.size}
        />
      ) : (
        <ChatsSectionHeader
          archivedTotal={archived.archivedTotal}
          headerRef={layout.headerRef}
          isArchiveMode={archived.isArchiveMode}
          isCollapsed={collapse.isCollapsed}
          isImportingConversations={chatImport.isImporting}
          onImportConversations={() =>
            void chatImport.handleImportConversations()
          }
          onToggleArchiveMode={archived.toggleArchiveMode}
          onToggleCollapsed={toggleCollapsed}
        />
      )}
      <ChatImportProgress progress={chatImport.progress} />
      <AutoDismissNotice
        durationMs={3000}
        message={chatImport.notice?.message ?? ""}
        onDismiss={chatImport.dismissNotice}
        tone={chatImport.notice?.tone ?? "success"}
      />
      <div
        className={`section-list${
          layout.isChatDragOver ? " chat-drag-over" : ""
        }`}
        ref={sectionListRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {archived.isArchiveMode ? (
          <ArchivedChatList
            archivedConversations={archived.archivedConversations}
            archivedError={archived.archivedError}
            archivedSelectedIds={archived.archivedSelectedIds}
            deletingArchivedIds={archived.deletingArchivedIds}
            directoryId={directoryId}
            hasMoreArchived={archived.hasMoreArchived}
            isArchivedLoading={archived.isArchivedLoading}
            isArchivedLoadingMore={archived.isArchivedLoadingMore}
            isArchivedMultiSelect={archived.isArchivedMultiSelect}
            isSwitchingDirectory={isSwitchingDirectory}
            loadMoreRef={archived.archivedLoadMoreRef}
            onBatchDelete={archived.handleBatchDeleteArchived}
            onBatchRestore={() => void archived.handleBatchRestore()}
            onDelete={archived.handleDeleteArchived}
            onDeselectAll={archived.handleArchivedDeselectAll}
            onEnterMultiSelect={archived.enterArchivedMultiSelect}
            onExitMultiSelect={archived.handleExitArchivedMultiSelect}
            onRestore={(conversation) =>
              void archived.handleRestore(conversation)
            }
            onSelectAll={archived.handleArchivedSelectAll}
            onToggleSelect={archived.handleArchivedToggleSelect}
            restoringIds={archived.restoringIds}
          />
        ) : showLoading ? (
          <span className="empty-text loading">
            <Loader2 className="spin" size={13} />
            {t("sidebar.loadingWorkspaceContent", {
              defaultValue: "Loading workspace content...",
            })}
          </span>
        ) : !directoryId ? (
          <span className="empty-text">
            {t("sidebar.noActiveDirectory", {
              defaultValue: "No active directory",
            })}
          </span>
        ) : list.error ? (
          <span className="empty-text error">{list.error}</span>
        ) : list.conversations.length === 0 &&
          crossProjectNotifications.length === 0 &&
          pinnedGroups.length === 0 ? (
          <span className="empty-text">
            {t("sidebar.noChats", { defaultValue: "No chats" })}
          </span>
        ) : (
          <>
            {/* 运行中会话分组：排在列表最前，随列表滚动（不固定） */}
            {runningGroup ? (
              <div className="chats-running-group">
                <ChatTimeGroupList
                  collapsedGroupKeys={layout.collapsedGroupKeys}
                  getGroupLabel={layout.getGroupLabel}
                  groups={[runningGroup]}
                  isMultiSelectable={selection.isMultiSelectable}
                  isMultiSelectMode={selection.isMultiSelectMode}
                  onToggleGroupCollapsed={layout.toggleGroupCollapsed}
                  onToggleGroupSelect={selection.handleToggleGroupSelect}
                  renderRow={renderConversationRow}
                  selectedIds={selection.selectedIds}
                />
              </div>
            ) : null}
            {/* 置顶会话分组：随列表滚动；拖入该分组=置顶，拖到普通列表区=取消置顶 */}
            {showPinnedGroup && (
              <div
                className={`chat-pinned-group${
                  isPinnedDragOver ? " chat-drag-over" : ""
                }`}
                onDragOver={handlePinnedDragOver}
                onDragLeave={handlePinnedDragLeave}
                onDrop={handlePinnedDrop}
              >
                <ChatTimeGroupList
                  collapsedGroupKeys={layout.collapsedGroupKeys}
                  getGroupLabel={layout.getGroupLabel}
                  groups={pinnedGroups}
                  isMultiSelectable={selection.isMultiSelectable}
                  isMultiSelectMode={selection.isMultiSelectMode}
                  onToggleGroupCollapsed={layout.toggleGroupCollapsed}
                  onToggleGroupSelect={selection.handleToggleGroupSelect}
                  renderRow={renderConversationRow}
                  selectedIds={selection.selectedIds}
                />
              </div>
            )}
            {/* 跨项目通知：其他项目运行中/需关注/已完成的会话，
                  点击自动切换项目并打开对应会话 */}
            {crossProjectNotifications.length > 0 && (
              <CrossProjectNotificationList
                groups={crossProjectNotifications}
                isCollapsed={layout.isCrossProjectCollapsed}
                onOpenNotification={(group, notification) =>
                  void handleOpenCrossProjectNotification(group, notification)
                }
                onToggleCollapsed={layout.toggleCrossProjectCollapsed}
              />
            )}
            <ChatTimeGroupList
              collapsedGroupKeys={layout.collapsedGroupKeys}
              getGroupLabel={layout.getGroupLabel}
              groups={contentGroups}
              isMultiSelectable={selection.isMultiSelectable}
              isMultiSelectMode={selection.isMultiSelectMode}
              onToggleGroupCollapsed={layout.toggleGroupCollapsed}
              onToggleGroupSelect={selection.handleToggleGroupSelect}
              renderRow={renderConversationRow}
              selectedIds={selection.selectedIds}
            />
            <ChatListFooter
              hasMore={list.hasMore}
              isLoadingMore={list.isLoadingMore}
              sentinelRef={list.loadMoreRef}
            />
          </>
        )}
      </div>
      <ChatsSectionDialogs
        archivedDeleteTargetIds={archived.archivedDeleteTargetIds}
        batchDeleteImages={actions.batchDeleteImages}
        batchDeleteMemories={actions.batchDeleteMemories}
        batchImagesCount={actions.batchImagesCount}
        batchMemoriesCount={actions.batchMemoriesCount}
        isBatchDeleting={actions.isBatchDeleting}
        isDeletingArchived={archived.deletingArchivedIds.size > 0}
        onArchivedDeleteCancel={() => archived.setArchivedDeleteTargetIds(null)}
        onArchivedDeleteConfirm={() =>
          void archived.handleArchivedDeleteConfirm()
        }
        onBatchCancel={() => actions.setShowBatchConfirm(false)}
        onBatchConfirm={() => void actions.handleBatchDelete()}
        onBatchImagesChange={actions.setBatchDeleteImages}
        onBatchMemoriesChange={actions.setBatchDeleteMemories}
        selectedCount={selection.selectedIds.size}
        showBatchConfirm={actions.showBatchConfirm}
      />
    </div>
  );
}
