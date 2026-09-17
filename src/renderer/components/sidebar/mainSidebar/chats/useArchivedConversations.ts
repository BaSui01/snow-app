import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import type { ChatConversationRecord } from "../../../../../preload";
import { useI18n } from "../../../../i18n";

const ARCHIVE_PAGE_SIZE = 20;

type UseArchivedConversationsOptions = {
  directoryId: string;
  isCollapsed: boolean;
  sectionListRef: RefObject<HTMLDivElement | null>;
  refreshConversations: () => void;
  onExitChatMultiSelect: () => void;
};

export function useArchivedConversations({
  directoryId,
  isCollapsed,
  sectionListRef,
  refreshConversations,
  onExitChatMultiSelect,
}: UseArchivedConversationsOptions) {
  const { t } = useI18n();
  // 归档模式：true 时侧边栏展示归档会话列表（还原后才能继续使用）
  const [isArchiveMode, setIsArchiveMode] = useState(false);
  const [archivedConversations, setArchivedConversations] = useState<
    ChatConversationRecord[]
  >([]);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [isArchivedLoading, setIsArchivedLoading] = useState(false);
  const [isArchivedLoadingMore, setIsArchivedLoadingMore] = useState(false);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const [archivedSelectedIds, setArchivedSelectedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isArchivedMultiSelect, setIsArchivedMultiSelect] = useState(false);
  // 归档会话永久删除确认：待删除的归档会话 ID（null = 未打开）
  const [archivedDeleteTargetIds, setArchivedDeleteTargetIds] = useState<
    string[] | null
  >(null);
  const [restoringIds, setRestoringIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingArchivedIds, setDeletingArchivedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const archivedLoadMoreRef = useRef<HTMLDivElement | null>(null);

  const loadArchivedFirstPage = useCallback(async (): Promise<void> => {
    if (!directoryId) {
      setArchivedConversations([]);
      setArchivedTotal(0);
      return;
    }

    setIsArchivedLoading(true);
    setArchivedError(null);

    try {
      const result = await window.snow.listArchivedConversationsPaginated(
        directoryId,
        ARCHIVE_PAGE_SIZE,
        0,
      );
      setArchivedConversations(result.items);
      setArchivedTotal(result.total);
    } catch (err) {
      setArchivedError(
        err instanceof Error
          ? err.message
          : t("sidebar.loadChatsError", {
              defaultValue: "Failed to load chats",
            }),
      );
    } finally {
      setIsArchivedLoading(false);
    }
  }, [directoryId, t]);

  // 进入归档模式或切换项目时加载归档列表第一页
  useEffect(() => {
    if (!isArchiveMode) {
      return;
    }
    void loadArchivedFirstPage();
  }, [isArchiveMode, loadArchivedFirstPage]);

  const hasMoreArchived = archivedConversations.length < archivedTotal;

  const loadArchivedMore = useCallback(async (): Promise<void> => {
    if (
      isArchivedLoadingMore ||
      !hasMoreArchived ||
      !directoryId ||
      isArchivedLoading
    ) {
      return;
    }

    setIsArchivedLoadingMore(true);

    try {
      const result = await window.snow.listArchivedConversationsPaginated(
        directoryId,
        ARCHIVE_PAGE_SIZE,
        archivedConversations.length,
      );
      setArchivedConversations((prev) => [...prev, ...result.items]);
      setArchivedTotal(result.total);
    } catch {
      // Silent fail for pagination
    } finally {
      setIsArchivedLoadingMore(false);
    }
  }, [
    archivedConversations.length,
    directoryId,
    hasMoreArchived,
    isArchivedLoading,
    isArchivedLoadingMore,
  ]);

  // 归档列表无限滚动
  useEffect(() => {
    if (
      !isArchiveMode ||
      !hasMoreArchived ||
      isArchivedLoading ||
      isCollapsed
    ) {
      return;
    }

    const sentinel = archivedLoadMoreRef.current;

    if (!sentinel) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadArchivedMore();
        }
      },
      {
        root: sectionListRef.current,
        rootMargin: "0px 0px 64px",
        threshold: 0.1,
      },
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [
    isArchiveMode,
    hasMoreArchived,
    isArchivedLoading,
    isCollapsed,
    loadArchivedMore,
    sectionListRef,
  ]);

  const handleExitArchivedMultiSelect = useCallback((): void => {
    if (deletingArchivedIds.size > 0 || restoringIds.size > 0) {
      return;
    }
    setIsArchivedMultiSelect(false);
    setArchivedSelectedIds(new Set());
  }, [deletingArchivedIds.size, restoringIds.size]);

  /** 切换会话区/归档区视图：切换后主动重拉目标视图的列表，
   *  避免还原/归档操作后出现列表数据滞后（还原的会话不可见） */
  const toggleArchiveMode = (): void => {
    if (isArchiveMode) {
      // 退出归档视图：回到普通会话列表并全量重拉
      setIsArchiveMode(false);
      handleExitArchivedMultiSelect();
      refreshConversations();
    } else {
      // 进入归档视图：退出普通多选模式，避免状态交叉
      onExitChatMultiSelect();
      setIsArchiveMode(true);
      void loadArchivedFirstPage();
    }
  };

  /** 还原单个归档会话 */
  const handleRestore = async (
    conversation: ChatConversationRecord,
  ): Promise<void> => {
    if (restoringIds.size > 0) {
      return;
    }
    setRestoringIds(new Set([conversation.conversationId]));
    try {
      await window.snow.restoreArchivedConversations([
        conversation.conversationId,
      ]);
      await loadArchivedFirstPage();
      refreshConversations();
    } catch {
      // Silent fail
    } finally {
      setRestoringIds(new Set());
    }
  };

  /** 批量还原所选归档会话 */
  const handleBatchRestore = async (): Promise<void> => {
    if (restoringIds.size > 0 || archivedSelectedIds.size === 0) {
      return;
    }

    setRestoringIds(new Set(archivedSelectedIds));
    try {
      await window.snow.restoreArchivedConversations([...archivedSelectedIds]);
      await loadArchivedFirstPage();
      refreshConversations();
      setArchivedSelectedIds(new Set());
      setIsArchivedMultiSelect(false);
    } catch {
      // Silent fail
    } finally {
      setRestoringIds(new Set());
    }
  };

  const handleDeleteArchived = (conversation: ChatConversationRecord): void => {
    setArchivedDeleteTargetIds([conversation.conversationId]);
  };

  /** 批量永久删除所选归档会话（弹出确认框） */
  const handleBatchDeleteArchived = (): void => {
    if (archivedSelectedIds.size === 0) {
      return;
    }
    setArchivedDeleteTargetIds([...archivedSelectedIds]);
  };

  /** 确认永久删除归档会话 */
  const handleArchivedDeleteConfirm = async (): Promise<void> => {
    if (deletingArchivedIds.size > 0 || !archivedDeleteTargetIds) {
      return;
    }

    setDeletingArchivedIds(new Set(archivedDeleteTargetIds));
    const targetIds = archivedDeleteTargetIds;

    try {
      await window.snow.deleteArchivedConversations(targetIds);
      await loadArchivedFirstPage();
      setArchivedSelectedIds(new Set());
      setIsArchivedMultiSelect(false);
    } catch {
      // Silent fail
    } finally {
      // 删除完成（含 VACUUM 收缩文件）后才关闭确认弹窗，期间显示 loading
      setDeletingArchivedIds(new Set());
      setArchivedDeleteTargetIds(null);
    }
  };

  const handleArchivedToggleSelect = (conversationId: string): void => {
    setArchivedSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
  };

  const handleArchivedSelectAll = (): void => {
    setArchivedSelectedIds(
      new Set(archivedConversations.map((conv) => conv.conversationId)),
    );
  };

  const handleArchivedDeselectAll = (): void => {
    setArchivedSelectedIds(new Set());
  };

  const enterArchivedMultiSelect = (): void => {
    setArchivedSelectedIds(new Set());
    setIsArchivedMultiSelect(true);
  };

  return {
    isArchiveMode,
    archivedConversations,
    archivedTotal,
    isArchivedLoading,
    isArchivedLoadingMore,
    archivedError,
    archivedSelectedIds,
    isArchivedMultiSelect,
    archivedDeleteTargetIds,
    setArchivedDeleteTargetIds,
    restoringIds,
    deletingArchivedIds,
    archivedLoadMoreRef,
    hasMoreArchived,
    loadArchivedFirstPage,
    toggleArchiveMode,
    handleRestore,
    handleBatchRestore,
    handleDeleteArchived,
    handleBatchDeleteArchived,
    handleArchivedDeleteConfirm,
    handleExitArchivedMultiSelect,
    enterArchivedMultiSelect,
    handleArchivedToggleSelect,
    handleArchivedSelectAll,
    handleArchivedDeselectAll,
  };
}
