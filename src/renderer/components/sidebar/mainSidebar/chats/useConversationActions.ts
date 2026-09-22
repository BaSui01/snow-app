import { useState } from "react";

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

  const handlePin = async (
    conversation: ChatConversationRecord,
  ): Promise<void> => {
    try {
      await window.snow.updateConversationStatus(
        conversation.conversationId,
        "pin",
      );
      refreshConversations();
    } catch {
      // Silent fail
    }
  };

  /** 取消置顶：状态改回 active，会话回到普通时间分组 */
  const handleUnpin = async (
    conversation: ChatConversationRecord,
  ): Promise<void> => {
    try {
      await window.snow.updateConversationStatus(
        conversation.conversationId,
        "active",
      );
      refreshConversations();
    } catch {
      // Silent fail
    }
  };

  const handleRename = async (
    conversation: ChatConversationRecord,
    newTitle: string,
  ): Promise<void> => {
    await window.snow.renameConversation(conversation.conversationId, newTitle);
    // 同步更新内存中 session 的 summary，让 TopBar 标题即时刷新
    updateConversationSummary(conversation.conversationId, newTitle);
    refreshConversations();
  };

  const handleSetEmoji = async (
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
  };

  const handleDelete = async (
    conversation: ChatConversationRecord,
    deleteImages: boolean,
    deleteMemories: boolean,
  ): Promise<void> => {
    if (deletingIds.size > 0) {
      return;
    }
    setDeletingIds(new Set([conversation.conversationId]));
    try {
      // 用户选择不保留图片时，先级联删除图库图片（物理 + 索引），
      // 再执行会话删除；删除失败不阻断会话删除
      if (deleteImages) {
        await window.snow.deleteConversationImages([
          conversation.conversationId,
        ]);
      }

      // Rust 侧级联删除子代理与 workflow 节点会话：收集全部待删 ID，
      // 以便中止对应流，并在当前正打开被删会话或其子层时清空聊天区
      const deleteTargetIds = collectConversationTreeIds(
        conversation.conversationId,
      );
      for (const targetId of deleteTargetIds) {
        abortConversation(targetId);
      }

      // deleteMemories=true 时在 Rust 删除事务内把该会话（含级联子会话）
      // 保存的项目记忆一并删除；默认保留
      await window.snow.deleteConversation(
        conversation.conversationId,
        deleteMemories,
      );

      // 删除的会话不再需要保留输入草稿
      for (const targetId of deleteTargetIds) {
        clearInputDraft(targetId);
      }

      if (
        activeConversationId &&
        deleteTargetIds.includes(activeConversationId)
      ) {
        handleNewChat();
      }
      refreshConversations();
    } catch {
      // Silent fail
    } finally {
      setDeletingIds(new Set());
    }
  };

  /** 归档单个会话：中止相关流、清理草稿，若正在打开则新建会话 */
  const handleArchive = async (
    conversation: ChatConversationRecord,
  ): Promise<void> => {
    if (archivingIds.size > 0) {
      return;
    }
    const archiveId = conversation.conversationId;
    setArchivingIds(new Set([archiveId]));
    try {
      const targetIds = collectConversationTreeIds(archiveId);
      for (const targetId of targetIds) {
        abortConversation(targetId);
      }

      await window.snow.archiveConversations([archiveId]);

      // 归档的会话不再需要保留输入草稿
      for (const targetId of targetIds) {
        clearInputDraft(targetId);
      }

      if (activeConversationId && targetIds.includes(activeConversationId)) {
        handleNewChat();
      }
      refreshConversations();
    } catch {
      // Silent fail
      refreshConversations();
    } finally {
      setArchivingIds(new Set());
    }
  };

  const handleExport = async (
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
  };

  /** 从侧边栏直接创建分支（复制整个会话），无需先打开会话 */
  const handleFork = (conversation: ChatConversationRecord): void => {
    void handleForkConversation(conversation.conversationId, "");
  };

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
      // 用户选择不保留图片时，先级联删除所选会话引用的图库图片
      // （物理 + 索引；会话随后被删除，无需重写消息）
      if (batchDeleteImages && (batchImagesCount ?? 0) > 0) {
        await window.snow.deleteConversationImages([...selectedIds]);
      }

      // 收集所有受影响会话 ID（含子代理、workflow 节点与节点子代理级联），
      // 用于中止流/清空聊天区
      const targetIds = new Set<string>();
      for (const convId of selectedIds) {
        for (const targetId of collectConversationTreeIds(convId)) {
          targetIds.add(targetId);
        }
      }

      for (const targetId of targetIds) {
        abortConversation(targetId);
      }

      // 单次批量删除：native 单事务完成（选中父会话时子代理随级联删除），
      // 避免逐条 IPC + 逐条事务（N+1）；deleteMemories=true 时在同一事务内
      // 把这些会话保存的项目记忆一并删除
      await window.snow.deleteConversations(
        [...selectedIds],
        batchDeleteMemories,
      );

      // 删除的会话不再需要保留输入草稿
      for (const targetId of targetIds) {
        clearInputDraft(targetId);
      }

      if (activeConversationId && targetIds.has(activeConversationId)) {
        handleNewChat();
      }
      refreshConversations();
      resetMultiSelect();
    } catch {
      // Silent fail
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
      // 收集所有受影响会话 ID（含子代理、workflow 节点与节点子代理级联），
      // 用于中止流/清空聊天区
      const targetIds = new Set<string>();
      for (const convId of selectedIds) {
        for (const targetId of collectConversationTreeIds(convId)) {
          targetIds.add(targetId);
        }
      }

      for (const targetId of targetIds) {
        abortConversation(targetId);
      }

      await window.snow.archiveConversations([...selectedIds]);

      // 归档的会话不再需要保留输入草稿
      for (const targetId of targetIds) {
        clearInputDraft(targetId);
      }

      if (activeConversationId && targetIds.has(activeConversationId)) {
        handleNewChat();
      }
      refreshConversations();
      resetMultiSelect();
    } catch {
      // Silent fail
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
