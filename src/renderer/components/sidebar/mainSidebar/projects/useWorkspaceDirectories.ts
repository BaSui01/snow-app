import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  WorkspaceDirectoryInput,
  WorkspaceDirectoryRecord,
} from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import {
  isOfflinePath,
  isRelinkablePath,
  parseUnavailableState,
  toPersistableDirectoryInput,
} from "./directoryInputs";

type UseWorkspaceDirectoriesOptions = {
  externalActiveDirectory?: WorkspaceDirectoryRecord | null;
  onActiveDirectoryChange?: (
    directory: WorkspaceDirectoryRecord | null,
  ) => void;
  onSwitchingDirectoryChange: (isSwitchingDirectory: boolean) => void;
};

export function useWorkspaceDirectories({
  externalActiveDirectory,
  onActiveDirectoryChange,
  onSwitchingDirectoryChange,
}: UseWorkspaceDirectoriesOptions) {
  const { t } = useI18n();
  const [workspaceDirectories, setWorkspaceDirectories] = useState<
    WorkspaceDirectoryRecord[]
  >([]);
  const [isLoadingDirectories, setIsLoadingDirectories] = useState(true);
  const [isSavingDirectory, setIsSavingDirectory] = useState(false);
  const [isReorderingDirectories, setIsReorderingDirectories] = useState(false);
  const [isSwitchingDirectory, setIsSwitchingDirectory] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  // 路径已失效的项目：打开重新定位对话框
  const [relinkTarget, setRelinkTarget] =
    useState<WorkspaceDirectoryRecord | null>(null);
  // 查看迁移记录的项目
  const [historyTarget, setHistoryTarget] =
    useState<WorkspaceDirectoryRecord | null>(null);

  const activeDirectory = useMemo(
    () => workspaceDirectories.find((directory) => directory.isActive),
    [workspaceDirectories],
  );

  useEffect(() => {
    onActiveDirectoryChange?.(activeDirectory ?? null);
  }, [activeDirectory, onActiveDirectoryChange]);

  const updateSwitchingDirectory = useCallback(
    (nextIsSwitching: boolean): void => {
      setIsSwitchingDirectory(nextIsSwitching);
      onSwitchingDirectoryChange(nextIsSwitching);
    },
    [onSwitchingDirectoryChange],
  );

  // Mirror values into refs so the external-sync effect can read the latest
  // state without re-running on every internal change (which would cause an
  // infinite loop with the upward-sync effect above).
  const activeDirectoryIdRef = useRef<string | undefined>(undefined);
  activeDirectoryIdRef.current = activeDirectory?.directoryId;
  const isSwitchingRef = useRef(isSwitchingDirectory);
  isSwitchingRef.current = isSwitchingDirectory;
  // Tracks the last external directoryId we have already processed so we
  // only react to genuine external changes (e.g. global search), not to
  // our own internal changes echoing back through the parent.
  const lastSyncedExternalIdRef = useRef<string | null>(null);

  // Sync internal state when the active directory changes from outside
  // (e.g. via global search). Only fires on real external changes.
  useEffect(() => {
    if (!externalActiveDirectory) {
      return;
    }
    const externalId = externalActiveDirectory.directoryId;
    // Already processed this external ID
    if (externalId === lastSyncedExternalIdRef.current) {
      return;
    }
    // Internal state already matches
    if (externalId === activeDirectoryIdRef.current) {
      lastSyncedExternalIdRef.current = externalId;
      return;
    }
    // In the middle of a switch
    if (isSwitchingRef.current) {
      return;
    }
    lastSyncedExternalIdRef.current = externalId;
    void (async (): Promise<void> => {
      updateSwitchingDirectory(true);
      setDirectoryError(null);
      try {
        const directories =
          await window.snow.activateWorkspaceDirectory(externalId);
        setWorkspaceDirectories(directories);
      } catch (error) {
        setDirectoryError(
          error instanceof Error
            ? error.message
            : t("sidebar.activateDirectoryError", {
                defaultValue: "Failed to activate workspace directory",
              }),
        );
      } finally {
        updateSwitchingDirectory(false);
      }
    })();
  }, [externalActiveDirectory, updateSwitchingDirectory, t]);

  const loadWorkspaceDirectories = useCallback(async (): Promise<void> => {
    setDirectoryError(null);

    try {
      const directories = await window.snow.listWorkspaceDirectories();
      setWorkspaceDirectories(directories);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.loadDirectoriesError", {
              defaultValue: "Failed to load workspace directories",
            }),
      );
    } finally {
      setIsLoadingDirectories(false);
    }
  }, [t]);

  useEffect(() => {
    void loadWorkspaceDirectories();
  }, [loadWorkspaceDirectories]);

  // Refresh the directory list whenever another part of the app (e.g. the
  // empty-chat greeting card or the SSH wizard) adds/activates/deletes a
  // workspace directory. The main process broadcasts
  // "workspace-directory-list:changed" after every mutation, so subscribing
  // here keeps the sidebar in sync without coupling components together.
  useEffect(() => {
    const unsubscribe = window.snow.onWorkspaceDirectoryListChanged(() => {
      void loadWorkspaceDirectories();
    });
    return unsubscribe;
  }, [loadWorkspaceDirectories]);

  const persistWorkspaceDirectory = useCallback(
    async (item: WorkspaceDirectoryInput): Promise<boolean> => {
      setIsSavingDirectory(true);
      setDirectoryError(null);

      try {
        const directories = await window.snow.upsertWorkspaceDirectory(item);
        setWorkspaceDirectories(directories);
        return true;
      } catch (error) {
        setDirectoryError(
          error instanceof Error
            ? error.message
            : t("sidebar.addDirectoryError", {
                defaultValue: "Failed to add workspace directory",
              }),
        );
        return false;
      } finally {
        setIsSavingDirectory(false);
      }
    },
    [t],
  );

  // 位置是否真的不可用由一次定点校验决定：位置已恢复时不再显示任何提示。
  // 返回 true 表示已拦截（弹对话框或给出提示），false 表示位置正常、可继续激活。
  const handleUnavailableDirectory = useCallback(
    async (directory: WorkspaceDirectoryRecord): Promise<boolean> => {
      try {
        const report = await window.snow.verifyWorkspaceDirectory(
          directory.directoryId,
        );

        if (report.state === "ok" || report.state === "remote") {
          await loadWorkspaceDirectories();
          return false;
        }

        if (report.state === "offline") {
          setDirectoryError(
            t("sidebar.directoryPathOfflineMessage", {
              defaultValue:
                "This project is unavailable because its disk is not mounted: {{path}}",
              values: { path: report.path || directory.path },
            }),
          );
          await loadWorkspaceDirectories();
          return true;
        }

        setDirectoryError(null);
        setRelinkTarget({
          ...directory,
          path: report.path || directory.path,
          lastKnownPath: report.lastKnownPath,
          pathState: report.state,
        });
        await loadWorkspaceDirectories();
        return true;
      } catch (error) {
        setDirectoryError(
          error instanceof Error
            ? error.message
            : t("sidebar.relinkDirectoryOpenError", {
                defaultValue: "Failed to check the project's location",
              }),
        );
        return true;
      }
    },
    [loadWorkspaceDirectories, t],
  );

  const handleActivateDirectory = async (
    directoryId: string,
  ): Promise<void> => {
    if (!directoryId) {
      return;
    }

    if (directoryId === activeDirectory?.directoryId) {
      if (isRelinkablePath(activeDirectory)) {
        void handleUnavailableDirectory(activeDirectory);
      } else if (isOfflinePath(activeDirectory)) {
        setDirectoryError(
          t("sidebar.directoryPathOfflineMessage", {
            defaultValue:
              "This project is unavailable because its disk is not mounted: {{path}}",
            values: { path: activeDirectory?.path ?? "" },
          }),
        );
      }
      return;
    }

    updateSwitchingDirectory(true);
    setDirectoryError(null);

    try {
      const target = workspaceDirectories.find(
        (directory) => directory.directoryId === directoryId,
      );

      // 缓存标记为失效时先定点校验：位置已恢复则照常激活，避免过期提示与无效拦截
      if (target && (isRelinkablePath(target) || isOfflinePath(target))) {
        const isBlocked = await handleUnavailableDirectory(target);
        if (isBlocked) {
          return;
        }
      }

      const directories =
        await window.snow.activateWorkspaceDirectory(directoryId);
      setWorkspaceDirectories(directories);
    } catch (error) {
      // 兜底：缓存状态过期（如目录在应用外被删除）时由主进程拦截并给出同样提示
      const message = error instanceof Error ? error.message : "";
      const unavailableState = parseUnavailableState(message);
      if (unavailableState === "offline") {
        setDirectoryError(
          t("sidebar.directoryPathOfflineMessage", {
            defaultValue:
              "This project is unavailable because its disk is not mounted: {{path}}",
            values: { path: directoryId },
          }),
        );
        void loadWorkspaceDirectories();
      } else if (unavailableState) {
        const target = workspaceDirectories.find(
          (directory) => directory.directoryId === directoryId,
        );
        if (target) {
          void handleUnavailableDirectory(target);
        } else {
          void loadWorkspaceDirectories();
        }
      } else {
        setDirectoryError(
          message ||
            t("sidebar.activateDirectoryError", {
              defaultValue: "Failed to activate workspace directory",
            }),
        );
      }
    } finally {
      updateSwitchingDirectory(false);
    }
  };

  const persistWorkspaceDirectoryOrder = async (
    orderedDirectories: WorkspaceDirectoryRecord[],
  ): Promise<void> => {
    setIsReorderingDirectories(true);
    setDirectoryError(null);

    try {
      const nextInputs = orderedDirectories.map((directory, index) =>
        toPersistableDirectoryInput(directory, index),
      );
      const directories =
        await window.snow.reorderWorkspaceDirectories(nextInputs);
      setWorkspaceDirectories(directories);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.reorderDirectoryError", {
              defaultValue: "Failed to reorder workspace directories",
            }),
      );
    } finally {
      setIsReorderingDirectories(false);
    }
  };

  const handleDeleteDirectory = async (directoryId: string): Promise<void> => {
    if (!directoryId) {
      return;
    }

    setIsSavingDirectory(true);
    setDirectoryError(null);

    try {
      const directories =
        await window.snow.deleteWorkspaceDirectory(directoryId);
      setWorkspaceDirectories(directories);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.deleteDirectoryError", {
              defaultValue: "Failed to delete workspace directory",
            }),
      );
    } finally {
      setIsSavingDirectory(false);
    }
  };

  // 重命名目录显示名：保留其余字段（directoryId/path/kind/isActive/
  // sortOrder/source），仅更新 name，不影响磁盘路径与排序。
  const handleRenameDirectory = async (
    directoryId: string,
    newName: string,
  ): Promise<void> => {
    const directory = workspaceDirectories.find(
      (d) => d.directoryId === directoryId,
    );
    if (!directory) {
      return;
    }

    setIsSavingDirectory(true);
    setDirectoryError(null);

    try {
      const directories = await window.snow.upsertWorkspaceDirectory({
        directoryId: directory.directoryId,
        name: newName,
        path: directory.path,
        kind: directory.kind,
        isActive: directory.isActive,
        sortOrder: directory.sortOrder,
        source: directory.source,
      });
      setWorkspaceDirectories(directories);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.renameDirectoryError", {
              defaultValue: "Failed to rename workspace directory",
            }),
      );
      // 向上抛出，让行内编辑保持错误可见（由列表在 finally 中退出编辑态）
      throw error;
    } finally {
      setIsSavingDirectory(false);
    }
  };

  const handleShowRelinkHistory = useCallback(
    (directoryId: string): void => {
      const target = workspaceDirectories.find(
        (directory) => directory.directoryId === directoryId,
      );
      if (!target) {
        return;
      }
      setDirectoryError(null);
      setHistoryTarget(target);
    },
    [workspaceDirectories],
  );

  return {
    workspaceDirectories,
    setWorkspaceDirectories,
    activeDirectory,
    isLoadingDirectories,
    isSavingDirectory,
    setIsSavingDirectory,
    isReorderingDirectories,
    isSwitchingDirectory,
    directoryError,
    setDirectoryError,
    relinkTarget,
    setRelinkTarget,
    historyTarget,
    setHistoryTarget,
    loadWorkspaceDirectories,
    persistWorkspaceDirectory,
    persistWorkspaceDirectoryOrder,
    handleUnavailableDirectory,
    handleActivateDirectory,
    handleDeleteDirectory,
    handleRenameDirectory,
    handleShowRelinkHistory,
  };
}
