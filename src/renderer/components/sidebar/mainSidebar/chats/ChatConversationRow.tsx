import {
  Fragment,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { useI18n } from "../../../../i18n";
import { isSubAgentTerminal } from "../../../../../shared/subAgentRuns";
import {
  useSubAgentDeletionStatus,
  useSubAgentRuns,
} from "../../../mainContent/chatMessages/hooks/subAgentRuntimeClient";
import "../../../mainContent/chatMessages/components/SubAgentRunDetails.css";

import type { ChatConversationRecord } from "../../../../../preload";
import { ChatItem } from "../ChatItem";
import { ChatDeleteConfirmDialog } from "../ChatDeleteConfirmDialog";
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
  onToggleSelect: (
    conversationId: string,
    modifiers?: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => boolean;
  onSelectionBlockedChange: (conversationId: string, blocked: boolean) => void;
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
  onSelectionBlockedChange,
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
  const { t } = useI18n();
  const conversationId = conversation.conversationId;
  const { runs, error: runsError } = useSubAgentRuns(
    isPendingSessionKey(conversationId) ? undefined : conversationId,
  );
  const deletion = useSubAgentDeletionStatus(
    isPendingSessionKey(conversationId) ? undefined : conversationId,
    isPendingSessionKey(conversationId) ? undefined : conversationId,
  );
  const deletionPending = isDeleting || deletion.deleting;
  const [retryDeleteCounts, setRetryDeleteCounts] = useState<{
    images: number;
    memories: number;
  } | null>(null);
  const [retryDeleteLoading, setRetryDeleteLoading] = useState(false);
  const [retryDeleteError, setRetryDeleteError] = useState<string | null>(null);
  const [deleteImages, setDeleteImages] = useState(false);
  const [deleteMemories, setDeleteMemories] = useState(false);
  // Reuse the existing conversation tree; undelivered results do not request user input.
  const activeRuns = runs.filter((run) => !isSubAgentTerminal(run.status));
  const hasActiveRuns = activeRuns.length > 0;
  useLayoutEffect(() => {
    onSelectionBlockedChange(conversationId, hasActiveRuns);
    return () => {
      onSelectionBlockedChange(conversationId, false);
    };
  }, [conversationId, hasActiveRuns, onSelectionBlockedChange]);
  const needsAttention = runs.some((run) => run.status === "waiting_input");
  const runAttentionIds = useMemo(
    () =>
      new Set([
        ...attentionRequiredConversationIds,
        ...runs
          .filter((run) => run.status === "waiting_input")
          .map((run) => run.conversationId),
      ]),
    [attentionRequiredConversationIds, runs],
  );
  const isWorkflow = workflowNodeConversations.length > 0;
  const hasTreeChildren = isWorkflow || subAgentConversations.length > 0;

  const handleSelect = useCallback(
    (event: React.MouseEvent | React.KeyboardEvent): void => {
      if (!onToggleSelect(conversationId, event)) {
        onSelectConversation(conversation);
      }
    },
    [conversation, conversationId, onSelectConversation, onToggleSelect],
  );
  const handleToggleSelect = useCallback(
    (event: React.MouseEvent | React.KeyboardEvent): void => {
      onToggleSelect(conversationId, event);
    },
    [conversationId, onToggleSelect],
  );
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
  const openRetryDelete = async (): Promise<void> => {
    setRetryDeleteLoading(true);
    setRetryDeleteError(null);
    try {
      const [images, memories] = await Promise.all([
        window.snow.countConversationImages([conversationId]),
        window.snow.countProjectMemoriesByConversations([conversationId]),
      ]);
      setDeleteImages(false);
      setDeleteMemories(false);
      setRetryDeleteCounts({ images, memories });
    } catch (error) {
      setRetryDeleteError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setRetryDeleteLoading(false);
    }
  };
  const confirmRetryDelete = (): void => {
    // Closing the confirmation only submits the existing action, never reports success.
    setRetryDeleteCounts(null);
    handleDelete(deleteImages, deleteMemories);
  };
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
        isAttentionRequired={
          needsAttention ||
          !!deletion.error ||
          !!retryDeleteError ||
          !!runsError ||
          attentionRequiredConversationIds.has(conversationId)
        }
        isStreaming={streamingConversationIds.has(conversationId)}
        isPaused={pausedConversationIds.has(conversationId)}
        isCompleted={
          activeRuns.length === 0 &&
          !needsAttention &&
          !runsError &&
          !deletionPending &&
          !deletion.error &&
          completedConversationIds.has(conversationId)
        }
        isRunning={
          activeRuns.length > 0 ||
          runningConversationIds.has(conversationId) ||
          surfacedConversationIds.has(conversationId)
        }
        showPinBadge={showPinBadge}
        subAgentConversations={subAgentConversations}
        subAgentAttentionRequiredIds={runAttentionIds}
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
      {runsError || deletionPending || deletion.error || retryDeleteError ? (
        <div className="sub-agent-run-sidebar">
          {deletionPending ? (
            <p role="status">{t("subAgentRun.sidebar.deleting")}</p>
          ) : null}
          {deletion.deleting ? (
            <p role="status">
              {t(
                deletion.ready
                  ? "subAgentRun.sidebar.readyToDelete"
                  : "subAgentRun.sidebar.waitingOwner",
              )}
            </p>
          ) : null}
          {deletion.error ? (
            <details open>
              <summary>{t("subAgentRun.sidebar.deletionError")}</summary>
              <pre role="alert">{deletion.error}</pre>
            </details>
          ) : null}
          {deletion.deleting || deletion.error ? (
            <div>
              <button type="button" onClick={() => void deletion.refresh()}>
                {t("subAgentRun.sidebar.refreshDeletion")}
              </button>
              {deletion.deleting ? (
                <>
                  <button
                    type="button"
                    disabled={isDeleting || retryDeleteLoading}
                    onClick={() => void openRetryDelete()}
                  >
                    {t("subAgentRun.sidebar.retryDelete")}
                  </button>
                  <p>{t("subAgentRun.sidebar.retryDeleteHint")}</p>
                </>
              ) : null}
            </div>
          ) : null}
          {retryDeleteLoading ? (
            <p role="status">{t("subAgentRun.sidebar.loadingDeleteOptions")}</p>
          ) : null}
          {retryDeleteError ? (
            <details open>
              <summary>{t("subAgentRun.sidebar.deleteOptionsError")}</summary>
              <pre role="alert">{retryDeleteError}</pre>
            </details>
          ) : null}
          {runsError ? (
            <details>
              <summary>{t("subAgentRun.queryFailed")}</summary>
              <pre role="alert">{runsError}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
      <ChatDeleteConfirmDialog
        open={retryDeleteCounts !== null}
        conversationCount={1}
        isBatch={false}
        imagesCount={retryDeleteCounts?.images ?? null}
        memoriesCount={retryDeleteCounts?.memories ?? null}
        deleteImages={deleteImages}
        deleteMemories={deleteMemories}
        onDeleteImagesChange={setDeleteImages}
        onDeleteMemoriesChange={setDeleteMemories}
        isConfirming={isDeleting}
        onCancel={() => setRetryDeleteCounts(null)}
        onConfirm={confirmRetryDelete}
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
                attentionRequiredConversationIds={runAttentionIds}
                onSelect={handleSelectChild}
              />
            ) : null}
          </>
        )}
      />
    </Fragment>
  );
});
