import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ProjectCollectionRecord } from "../../../../../preload";
import { useI18n } from "../../../../i18n";

type UseProjectCollectionsOptions = {
  activeDirectoryId?: string;
  activeConversationId?: string;
  setDirectoryError: (message: string | null) => void;
  setIsSavingDirectory: (saving: boolean) => void;
};

export function useProjectCollections({
  activeDirectoryId,
  activeConversationId,
  setDirectoryError,
  setIsSavingDirectory,
}: UseProjectCollectionsOptions) {
  const { t } = useI18n();
  const [collections, setCollections] = useState<ProjectCollectionRecord[]>([]);
  const [expandedCollectionIds, setExpandedCollectionIds] = useState<
    Set<string>
  >(() => new Set());
  const [deleteCollectionTarget, setDeleteCollectionTarget] =
    useState<ProjectCollectionRecord | null>(null);

  const loadProjectCollections = useCallback(async (): Promise<void> => {
    try {
      const items = await window.snow.listProjectCollections();
      setCollections(items);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.loadCollectionsError", {
              defaultValue: "Failed to load project collections",
            }),
      );
    }
  }, [setDirectoryError, t]);

  useEffect(() => {
    void loadProjectCollections();
  }, [loadProjectCollections]);

  useEffect(() => {
    const unsubscribe = window.snow.onWorkspaceDirectoryListChanged(() => {
      void loadProjectCollections();
    });
    return unsubscribe;
  }, [loadProjectCollections]);

  // 已收纳进合集的项目：顶层列表不再展示，仅显示在合集中
  const collectionMemberIds = useMemo(() => {
    const ids = new Set<string>();
    for (const collection of collections) {
      for (const id of collection.memberDirectoryIds) {
        ids.add(id);
      }
    }
    return ids;
  }, [collections]);

  const lastAutoExpandSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeDirectoryId) {
      return;
    }
    const containingCollectionIds = collections
      .filter((collection) =>
        collection.memberDirectoryIds.includes(activeDirectoryId),
      )
      .map((collection) => collection.collectionId);
    if (containingCollectionIds.length === 0) {
      return;
    }
    const signature = `${activeDirectoryId}:${activeConversationId ?? ""}:${containingCollectionIds.join(",")}`;
    if (lastAutoExpandSignatureRef.current === signature) {
      return;
    }
    lastAutoExpandSignatureRef.current = signature;
    setExpandedCollectionIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const collectionId of containingCollectionIds) {
        if (!next.has(collectionId)) {
          next.add(collectionId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeConversationId, activeDirectoryId, collections]);

  const handleToggleCollectionExpanded = (collectionId: string): void => {
    setExpandedCollectionIds((prev) => {
      const next = new Set(prev);
      if (next.has(collectionId)) {
        next.delete(collectionId);
      } else {
        next.add(collectionId);
      }
      return next;
    });
  };

  const createCollection = async (
    name: string,
    memberDirectoryIds: string[] = [],
  ): Promise<boolean> => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return false;
    }

    setIsSavingDirectory(true);
    setDirectoryError(null);

    try {
      const nextCollections = await window.snow.createProjectCollection(
        trimmedName,
        memberDirectoryIds,
      );
      setCollections(nextCollections);
      return true;
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.createCollectionError", {
              defaultValue: "Failed to create collection",
            }),
      );
      return false;
    } finally {
      setIsSavingDirectory(false);
    }
  };

  /** 修改项目组统一颜色（关联项目组的圆点标识色）。 */
  const updateCollectionColor = async (
    collectionId: string,
    color: string,
  ): Promise<boolean> => {
    setIsSavingDirectory(true);
    setDirectoryError(null);

    try {
      const nextCollections = await window.snow.updateProjectCollectionColor(
        collectionId,
        color,
      );
      setCollections(nextCollections);
      return true;
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.updateCollectionColorError", {
              defaultValue: "Failed to update the collection color",
            }),
      );
      return false;
    } finally {
      setIsSavingDirectory(false);
    }
  };

  /** 切换成员的「参与关联」：断连后该目录仍留在合集里，只是不参与关联。 */
  const setMemberLinked = async (
    collectionId: string,
    directoryId: string,
    linked: boolean,
  ): Promise<void> => {
    setIsSavingDirectory(true);
    setDirectoryError(null);

    try {
      const nextCollections =
        await window.snow.setProjectCollectionMemberLinked(
          collectionId,
          directoryId,
          linked,
        );
      setCollections(nextCollections);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.setMemberLinkedError", {
              defaultValue: "Failed to update the linked member",
            }),
      );
    } finally {
      setIsSavingDirectory(false);
    }
  };

  const renameCollection = async (
    collectionId: string,
    name: string,
  ): Promise<boolean> => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return false;
    }

    setIsSavingDirectory(true);
    setDirectoryError(null);

    try {
      const nextCollections = await window.snow.renameProjectCollection(
        collectionId,
        trimmedName,
      );
      setCollections(nextCollections);
      return true;
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.renameCollectionError", {
              defaultValue: "Failed to rename collection",
            }),
      );
      return false;
    } finally {
      setIsSavingDirectory(false);
    }
  };

  const confirmDeleteCollection = async (): Promise<void> => {
    if (!deleteCollectionTarget) {
      return;
    }

    const target = deleteCollectionTarget;
    setIsSavingDirectory(true);
    setDirectoryError(null);

    try {
      const nextCollections = await window.snow.deleteProjectCollection(
        target.collectionId,
      );
      setCollections(nextCollections);
      setDeleteCollectionTarget(null);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.deleteCollectionError", {
              defaultValue: "Failed to delete collection",
            }),
      );
    } finally {
      setIsSavingDirectory(false);
    }
  };

  const removeProjectFromCollection = async (
    collectionId: string,
    directoryId: string,
  ): Promise<void> => {
    setIsSavingDirectory(true);
    setDirectoryError(null);

    try {
      const nextCollections = await window.snow.removeProjectFromCollection(
        collectionId,
        directoryId,
      );
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
  };

  const removeProjectFromAllCollections = async (
    directoryId: string,
  ): Promise<void> => {
    setIsSavingDirectory(true);
    setDirectoryError(null);

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
  };

  return {
    collections,
    setCollections,
    collectionMemberIds,
    expandedCollectionIds,
    handleToggleCollectionExpanded,
    deleteCollectionTarget,
    setDeleteCollectionTarget,
    loadProjectCollections,
    createCollection,
    updateCollectionColor,
    setMemberLinked,
    renameCollection,
    confirmDeleteCollection,
    removeProjectFromCollection,
    removeProjectFromAllCollections,
  };
}
