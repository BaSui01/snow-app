import { useCallback, useEffect, useMemo, useState } from "react";

import type { ProjectCollectionRecord } from "../../../../../preload";
import { useI18n } from "../../../../i18n";

type UseProjectCollectionsOptions = {
  setDirectoryError: (message: string | null) => void;
  setIsSavingDirectory: (saving: boolean) => void;
};

export function useProjectCollections({
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

  const createCollection = async (name: string): Promise<boolean> => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return false;
    }

    setIsSavingDirectory(true);
    setDirectoryError(null);

    try {
      const nextCollections = await window.snow.createProjectCollection(
        trimmedName,
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
    renameCollection,
    confirmDeleteCollection,
    removeProjectFromCollection,
    removeProjectFromAllCollections,
  };
}