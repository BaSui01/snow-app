import { useState } from "react";

import type {
  ProjectCollectionRecord,
  WorkspaceDirectoryRecord,
} from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import { toPersistableDirectoryInput } from "./directoryInputs";

type UseDirectoryDragDropOptions = {
  workspaceDirectories: WorkspaceDirectoryRecord[];
  setWorkspaceDirectories: (directories: WorkspaceDirectoryRecord[]) => void;
  collections: ProjectCollectionRecord[];
  setCollections: (collections: ProjectCollectionRecord[]) => void;
  collectionMemberIds: Set<string>;
  setIsSavingDirectory: (saving: boolean) => void;
  setDirectoryError: (message: string | null) => void;
  persistWorkspaceDirectoryOrder: (
    orderedDirectories: WorkspaceDirectoryRecord[],
  ) => Promise<void>;
};

export function useDirectoryDragDrop({
  workspaceDirectories,
  setWorkspaceDirectories,
  collections,
  setCollections,
  collectionMemberIds,
  setIsSavingDirectory,
  setDirectoryError,
  persistWorkspaceDirectoryOrder,
}: UseDirectoryDragDropOptions) {
  const { t } = useI18n();
  const [draggedDirectoryId, setDraggedDirectoryId] = useState<string | null>(
    null,
  );
  const [dragOverDirectoryId, setDragOverDirectoryId] = useState<string | null>(
    null,
  );
  const [dragOverCollectionId, setDragOverCollectionId] = useState<
    string | null
  >(null);

  const handleDirectoryDragStart = (directoryId: string): void => {
    setDraggedDirectoryId(directoryId);
    setDragOverDirectoryId(null);
    setDragOverCollectionId(null);
  };

  const handleDirectoryDragOver = (directoryId: string): void => {
    setDragOverDirectoryId(directoryId);
    // 行高亮与合集高亮互斥，避免拖动跨区域时残留旧的高亮
    setDragOverCollectionId(null);
  };

  const handleDirectoryDragEnd = (): void => {
    setDraggedDirectoryId(null);
    setDragOverDirectoryId(null);
    setDragOverCollectionId(null);
  };

  // 顶层项目行 drop：同为顶层项目 → 全量排序；源为合集成员 → 移出合集并落到目标位置。
  const handleDirectoryDrop = (
    targetDirectoryId: string,
    dataTransfer?: DataTransfer,
  ): void => {
    // React 状态可能未及时同步：优先用 state，缺失时从 dataTransfer 兜底
    const sourceId =
      draggedDirectoryId ?? dataTransfer?.getData("text/plain") ?? null;
    if (!sourceId || sourceId === targetDirectoryId) {
      handleDirectoryDragEnd();
      return;
    }

    const sourceIndex = workspaceDirectories.findIndex(
      (directory) => directory.directoryId === sourceId,
    );
    const targetIndex = workspaceDirectories.findIndex(
      (directory) => directory.directoryId === targetDirectoryId,
    );

    if (sourceIndex < 0 || targetIndex < 0) {
      handleDirectoryDragEnd();
      return;
    }

    const nextDirectories = [...workspaceDirectories];
    const [movedDirectory] = nextDirectories.splice(sourceIndex, 1);
    nextDirectories.splice(targetIndex, 0, movedDirectory);
    handleDirectoryDragEnd();

    if (collectionMemberIds.has(sourceId)) {
      // 移出合集：先持久化顶层顺序（此刻项目仍在合集内，位置变化不可见），
      // 再从所有合集移出——项目随即出现在目标位置，避免中间态跳动。
      setIsSavingDirectory(true);
      setDirectoryError(null);
      void (async (): Promise<void> => {
        try {
          const reorderedDirectories =
            await window.snow.reorderWorkspaceDirectories(
              nextDirectories.map((directory, index) =>
                toPersistableDirectoryInput(directory, index),
              ),
            );
          setWorkspaceDirectories(reorderedDirectories);
          const nextCollections =
            await window.snow.removeProjectFromAllCollections(sourceId);
          setCollections(nextCollections);
        } catch (error) {
          setDirectoryError(
            error instanceof Error
              ? error.message
              : t("sidebar.removeFromCollectionError", {
                  defaultValue: "Failed to remove project from collection",
                }),
          );
        } finally {
          setIsSavingDirectory(false);
        }
      })();
      return;
    }

    setWorkspaceDirectories(nextDirectories);
    void persistWorkspaceDirectoryOrder(nextDirectories);
  };

  // 拖到顶层列表空白区域：合集成员移出合集，回到顶层原位置。
  const handleDropOutside = (directoryId: string): void => {
    if (!collectionMemberIds.has(directoryId)) {
      handleDirectoryDragEnd();
      return;
    }
    handleDirectoryDragEnd();

    setIsSavingDirectory(true);
    setDirectoryError(null);
    void (async (): Promise<void> => {
      try {
        const nextCollections =
          await window.snow.removeProjectFromAllCollections(directoryId);
        setCollections(nextCollections);
      } catch (error) {
        setDirectoryError(
          error instanceof Error
            ? error.message
            : t("sidebar.removeFromCollectionError", {
                defaultValue: "Failed to remove project from collection",
              }),
        );
      } finally {
        setIsSavingDirectory(false);
      }
    })();
  };

  const handleCollectionDragOver = (collectionId: string): void => {
    setDragOverCollectionId(collectionId);
    // 合集高亮与行高亮互斥，避免拖动跨区域时残留旧的高亮
    setDragOverDirectoryId(null);
  };

  // 拖到合集标题行：项目归入该合集（新成员追加到末尾；已在合集则保持原顺序，
  // 仅确认归属——从其它合集中移出）。
  const handleCollectionDrop = (
    collectionId: string,
    fallbackDirectoryId?: string,
  ): void => {
    const sourceId = draggedDirectoryId ?? fallbackDirectoryId ?? null;
    if (!sourceId) {
      handleDirectoryDragEnd();
      return;
    }

    const collection = collections.find(
      (item) => item.collectionId === collectionId,
    );
    if (!collection) {
      handleDirectoryDragEnd();
      return;
    }

    const memberIds = collection.memberDirectoryIds;
    const orderedMemberIds = memberIds.includes(sourceId)
      ? [...memberIds]
      : [...memberIds, sourceId];
    handleDirectoryDragEnd();

    setIsSavingDirectory(true);
    setDirectoryError(null);
    void (async (): Promise<void> => {
      try {
        const nextCollections = await window.snow.moveProjectToCollection(
          collectionId,
          sourceId,
          orderedMemberIds,
        );
        setCollections(nextCollections);
      } catch (error) {
        setDirectoryError(
          error instanceof Error
            ? error.message
            : t("sidebar.addToCollectionError", {
                defaultValue: "Failed to add project to collection",
              }),
        );
      } finally {
        setIsSavingDirectory(false);
      }
    })();
  };

  // 合集成员行之间的 drop：源与目标同属一个合集 → 合集内成员重排；
  // 源为顶层项目或其它合集成员 → 移动到该合集的目标位置。
  const handleCollectionMemberDrop = (
    collectionId: string,
    targetDirectoryId: string,
    dataTransfer?: DataTransfer,
  ): void => {
    const sourceId =
      draggedDirectoryId ?? dataTransfer?.getData("text/plain") ?? null;
    if (!sourceId || sourceId === targetDirectoryId) {
      handleDirectoryDragEnd();
      return;
    }

    const collection = collections.find(
      (item) => item.collectionId === collectionId,
    );
    if (!collection) {
      handleDirectoryDragEnd();
      return;
    }

    const memberIds = collection.memberDirectoryIds;
    const targetIndex = memberIds.indexOf(targetDirectoryId);
    if (targetIndex < 0) {
      handleDirectoryDragEnd();
      return;
    }

    // 与顶层 drop 相同的 splice 语义：先移除源，再按目标原索引插入
    // （向上拖插到目标前、向下拖插到目标后；外部来源统一插到目标前）。
    const nextMemberIds = [...memberIds];
    const sourceIndex = nextMemberIds.indexOf(sourceId);
    const isWithinCollection = sourceIndex >= 0;
    if (isWithinCollection) {
      nextMemberIds.splice(sourceIndex, 1);
    }
    nextMemberIds.splice(targetIndex, 0, sourceId);
    handleDirectoryDragEnd();

    setIsSavingDirectory(true);
    setDirectoryError(null);
    void (async (): Promise<void> => {
      try {
        const nextCollections = isWithinCollection
          ? await window.snow.reorderProjectCollectionMembers(
              collectionId,
              nextMemberIds,
            )
          : await window.snow.moveProjectToCollection(
              collectionId,
              sourceId,
              nextMemberIds,
            );
        setCollections(nextCollections);
      } catch (error) {
        setDirectoryError(
          error instanceof Error
            ? error.message
            : isWithinCollection
              ? t("sidebar.reorderCollectionMembersError", {
                  defaultValue: "Failed to reorder projects in collection",
                })
              : t("sidebar.addToCollectionError", {
                  defaultValue: "Failed to add project to collection",
                }),
        );
      } finally {
        setIsSavingDirectory(false);
      }
    })();
  };

  return {
    draggedDirectoryId,
    dragOverDirectoryId,
    dragOverCollectionId,
    handleDirectoryDragStart,
    handleDirectoryDragOver,
    handleDirectoryDragEnd,
    handleDirectoryDrop,
    handleDropOutside,
    handleCollectionDragOver,
    handleCollectionDrop,
    handleCollectionMemberDrop,
  };
}