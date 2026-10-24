import { removeConversationTrees } from "../../../mainContent/chatMessages/hooks/conversationMessageBridge";
import { setSubAgentDeletionError } from "../../../mainContent/chatMessages/hooks/subAgentRuntimeClient";
import { useCallback, useRef, useState } from "react";

import type { ChatConversationRecord } from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import type { ExportFormat } from "../ChatItemMenu";

type UseConversationActionsOptions = {
  activeConversationId: string | undefined;
  selectedIds: Set<string>;
  resetMultiSelect: () => void;
  collectConversationTreeIds: (conversationId: string) => string[];
  refreshConversations: () => void;
  updateConversationSummary: (conversationId: string, summary: string) => void;
  abortConversation: (conversationId: string) => void;
  clearInputDraft: (conversationId: string) => void;
  handleNewChat: () => void;
  handleForkConversation: (
    conversationId: string,
    messageId: string,
  ) => Promise<void> | void;
  setConversations: (
    updater: (prev: ChatConversationRecord[]) => ChatConversationRecord[],
  ) => void;
};

export function useConversationActions({
  activeConversationId,
  selectedIds,
  resetMultiSelect,
  collectConversationTreeIds,
  refreshConversations,
  updateConversationSummary,
  abortConversation,
  clearInputDraft,
  handleNewChat,
  handleForkConversation,
  setConversations,
}: UseConversationActionsOptions) {
  const { t } = useI18n();
  // 活动会话 id 的实时镜像：删除/归档要判断"是否正在打开被删会话"，但把它
  // 放进 useCallback 依赖会让这两个回调在每次切换会话时换引用，从而让整张
  // 会话列表的 memo 全部失效（每次切换重渲染所有行）。
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [archivingIds, setArchivingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);
  const [batchImagesCount, setBatchImagesCount] = useState<number | null>(null);
  const [batchDeleteImages, setBatchDeleteImages] = useState(false);
  const [batchMemoriesCount, setBatchMemoriesCount] = useState<number | null>(
    null,
  );
  const [batchDeleteMemories, setBatchDeleteMemories] = useState(false);

  const handlePin = useCallback(
    async (conversation: ChatConversationRecord): Promise<void> => {
      try {
        await window.snow.updateConversationStatus(
          conversation.conversationId,
          "pin",
        );
        refreshConversations();
      } catch {
        // Silent fail
      }
    },
    [refreshConversations],
  );

  /** 取消置顶：状态改回 active，会话回到普通时间分组 */
  const handleUnpin = useCallback(
    async (conversation: ChatConversationRecord): Promise<void> => {
      try {
        await window.snow.updateConversationStatus(
          conversation.conversationId,
          "active",
        );
        refreshConversations();
      } catch {
        // Silent fail
      }
    },
    [refreshConversations],
  );

  const handleRename = useCallback(
    async (
      conversation: ChatConversationRecord,
      newTitle: string,
    ): Promise<void> => {
      await window.snow.renameConversation(
        conversation.conversationId,
        newTitle,
      );
      // 同步更新内存中 session 的 summary，让 TopBar 标题即时刷新
      updateConversationSummary(conversation.conversationId, newTitle);
      refreshConversations();
    },
    [refreshConversations, updateConversationSummary],
  );

  const handleSetEmoji = useCallback(
    async (
      conversation: ChatConversationRecord,
      emoji: string,
    ): Promise<void> => {
      // 乐观更新：直接修改本地 state，异步落库，不刷新列表
      setConversations((prev) =>
        prev.map((item) =>
          item.conversationId === conversation.conversationId
            ? { ...item, emoji }
            : item,
        ),
      );
      try {
        await window.snow.updateConversationEmoji(
          conversation.conversationId,
          emoji,
        );
      } catch {
        // 落库失败时回滚
        setConversations((prev) =>
          prev.map((item) =>
            item.conversationId === conversation.conversationId
              ? { ...item, emoji: conversation.emoji }
              : item,
          ),
        );
      }
    },
    [setConversations],
  );

  const handleDelete = useCallback(
    async (
      conversation: ChatConversationRecord,
      deleteImages: boolean,
      deleteMemories: boolean,
    ): Promise<void> => {
      if (deletingIds.size > 0) {
        return;
      }
      setDeletingIds(new Set([conversation.conversationId]));
      try {
        setSubAgentDeletionError(conversation.conversationId, null);
        await removeConversationTrees(
          [conversation.conversationId],
          async () => {
            if (deleteImages)
              await window.snow.deleteConversationImages([
                conversation.conversationId,
              ]);
            await window.snow.deleteConversation(
              conversation.conversationId,
              deleteMemories,
            );
          },
          { skipPinned: false },
        );
        refreshConversations();
      } catch (error) {
        setSubAgentDeletionError(
          conversation.conversationId,
          error instanceof Error ? error.message : String(error),
        );
        refreshConversations();
      } finally {
        setDeletingIds(new Set());
      }
    },
    [
      abortConversation,
      clearInputDraft,
      collectConversationTreeIds,
      deletingIds,
      handleNewChat,
      refreshConversations,
    ],
  );

  /** 归档单个会话：中止相关流、清理草稿，若正在打开则新建会话 */
  const handleArchive = useCallback(
    async (conversation: ChatConversationRecord): Promise<void> => {
      if (archivingIds.size > 0) {
        return;
      }
      const archiveId = conversation.conversationId;
      setArchivingIds(new Set([archiveId]));
      try {
        setSubAgentDeletionError(archiveId, null);
        await removeConversationTrees(
          [archiveId],
          () => window.snow.archiveConversations([archiveId]),
          { skipPinned: true },
        );
        refreshConversations();
      } catch (error) {
        setSubAgentDeletionError(
          archiveId,
          error instanceof Error ? error.message : String(error),
        );
        refreshConversations();
      } finally {
        setArchivingIds(new Set());
      }
    },
    [
      abortConversation,
      archivingIds,
      clearInputDraft,
      collectConversationTreeIds,
      handleNewChat,
      refreshConversations,
    ],
  );

  const handleExport = useCallback(
    async (
      conversation: ChatConversationRecord,
      format: ExportFormat,
    ): Promise<void> => {
      const fileName =
        conversation.summary ||
        conversation.title ||
        t("sidebar.untitledChat", { defaultValue: "Untitled" });
      await window.snow.exportConversation(
        conversation.conversationId,
        format,
        fileName,
      );
    },
    [t],
  );

  /** 从侧边栏直接创建分支（复制整个会话），无需先打开会话 */
  const handleFork = useCallback(
    (conversation: ChatConversationRecord): void => {
      void handleForkConversation(conversation.conversationId, "");
    },
    [handleForkConversation],
  );

  // 打开批量删除确认框：查询所选会话引用的图库图片数
  const handleOpenBatchConfirm = (): void => {
    setShowBatchConfirm(true);
    setBatchImagesCount(null);
    setBatchDeleteImages(false);
    // 同时查询所选会话保存的项目记忆数（>0 才显示「同时删除记忆」选项）
    setBatchMemoriesCount(null);
    setBatchDeleteMemories(false);
    if (selectedIds.size > 0) {
      void window.snow
        .countConversationImages([...selectedIds])
        .then((count) => setBatchImagesCount(count))
        .catch(() => setBatchImagesCount(0));
      void window.snow
        .countProjectMemoriesByConversations([...selectedIds])
        .then((count) => setBatchMemoriesCount(count))
        .catch(() => setBatchMemoriesCount(0));
    }
  };

  const handleBatchDelete = async (): Promise<void> => {
    if (isBatchDeleting || selectedIds.size === 0) {
      return;
    }

    setIsBatchDeleting(true);

    try {
      for (const id of selectedIds) setSubAgentDeletionError(id, null);
      await removeConversationTrees(
        [...selectedIds],
        async () => {
          if (batchDeleteImages && (batchImagesCount ?? 0) > 0)
            await window.snow.deleteConversationImages([...selectedIds]);
          await window.snow.deleteConversations(
            [...selectedIds],
            batchDeleteMemories,
          );
        },
        { skipPinned: false },
      );
      refreshConversations();
      resetMultiSelect();
    } catch (error) {
      for (const id of selectedIds)
        setSubAgentDeletionError(
          id,
          error instanceof Error ? error.message : String(error),
        );
      refreshConversations();
    } finally {
      // 删除完成后才关闭确认弹窗，期间显示 loading
      setIsBatchDeleting(false);
      setShowBatchConfirm(false);
    }
  };

  /** 批量归档所选会话（置顶会话由 Rust 侧跳过，不参与归档） */
  const handleBatchArchive = async (): Promise<void> => {
    if (archivingIds.size > 0 || selectedIds.size === 0) {
      return;
    }

    setArchivingIds(new Set(selectedIds));
    try {
      for (const id of selectedIds) setSubAgentDeletionError(id, null);
      await removeConversationTrees(
        [...selectedIds],
        () => window.snow.archiveConversations([...selectedIds]),
        { skipPinned: true },
      );
      refreshConversations();
      resetMultiSelect();
    } catch (error) {
      for (const id of selectedIds)
        setSubAgentDeletionError(
          id,
          error instanceof Error ? error.message : String(error),
        );
      refreshConversations();
    } finally {
      setArchivingIds(new Set());
    }
  };

  const isActionLocked = isBatchDeleting || archivingIds.size > 0;

  return {
    deletingIds,
    archivingIds,
    isBatchDeleting,
    showBatchConfirm,
    setShowBatchConfirm,
    batchImagesCount,
    batchDeleteImages,
    setBatchDeleteImages,
    batchMemoriesCount,
    batchDeleteMemories,
    setBatchDeleteMemories,
    isActionLocked,
    handlePin,
    handleUnpin,
    handleRename,
    handleSetEmoji,
    handleDelete,
    handleArchive,
    handleExport,
    handleFork,
    handleOpenBatchConfirm,
    handleBatchDelete,
    handleBatchArchive,
  };
}
