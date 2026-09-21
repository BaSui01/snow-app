import { useMemo, useRef, useState } from "react";

import type {
  ProjectCollectionRecord,
  WorkspaceDirectoryInput,
  WorkspaceDirectoryKind,
  WorkspaceDirectoryRecord,
} from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import { isCloneCanceledError, type CloneTask } from "./cloneTasks";
import {
  deriveRepoNameFromUrl,
  joinCloneTargetPath,
  toWorkspaceDirectoryInput,
} from "./directoryInputs";

type AddDirectoryMode = "" | WorkspaceDirectoryKind;

type UseProjectAddFlowOptions = {
  workspaceDirectories: WorkspaceDirectoryRecord[];
  setWorkspaceDirectories: (directories: WorkspaceDirectoryRecord[]) => void;
  persistWorkspaceDirectory: (
    item: WorkspaceDirectoryInput,
  ) => Promise<boolean>;
  createCollection: (name: string) => Promise<boolean>;
  renameCollection: (collectionId: string, name: string) => Promise<boolean>;
  setIsSavingDirectory: (saving: boolean) => void;
  setDirectoryError: (message: string | null) => void;
  onOpenSshWizard?: () => void;
};

export function useProjectAddFlow({
  workspaceDirectories,
  setWorkspaceDirectories,
  persistWorkspaceDirectory,
  createCollection,
  renameCollection,
  setIsSavingDirectory,
  setDirectoryError,
  onOpenSshWizard,
}: UseProjectAddFlowOptions) {
  const { t } = useI18n();
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const [addDirectoryMode, setAddDirectoryMode] =
    useState<AddDirectoryMode>("");
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false);
  const [projectNameInput, setProjectNameInput] = useState("");
  const [isAddLocalDialogOpen, setIsAddLocalDialogOpen] = useState(false);
  const [selectedLocalPath, setSelectedLocalPath] = useState("");
  const [isDraggingLocalDirectory, setIsDraggingLocalDirectory] =
    useState(false);
  const [isCloneRepoOpen, setIsCloneRepoOpen] = useState(false);
  const [cloneRepoUrl, setCloneRepoUrl] = useState("");
  const [cloneParentPath, setCloneParentPath] = useState("");
  // 克隆任务：弹窗关闭后克隆仍在后台进行，占位条目在侧边栏项目区
  // 展示进度与取消入口，因此任务列表独立于弹窗的开关状态。
  const [cloneTasks, setCloneTasks] = useState<CloneTask[]>([]);
  const [activeCloneStreamId, setActiveCloneStreamId] = useState<string | null>(
    null,
  );
  const [isCloneSubmitting, setIsCloneSubmitting] = useState(false);
  const [isCloneAborting, setIsCloneAborting] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  // 克隆失败时判断错误该落在弹窗还是占位条目：克隆期间用户可能已经
  // 关闭弹窗，异步回调读不到最新 state，故镜像到 ref。
  const isCloneRepoOpenRef = useRef(false);
  isCloneRepoOpenRef.current = isCloneRepoOpen;
  const [isCreateCollectionOpen, setIsCreateCollectionOpen] = useState(false);
  const [createCollectionName, setCreateCollectionName] = useState("");
  const [isRenameCollectionOpen, setIsRenameCollectionOpen] = useState(false);
  const [renameCollectionName, setRenameCollectionName] = useState("");
  const [editingCollection, setEditingCollection] =
    useState<ProjectCollectionRecord | null>(null);

  // 克隆的最终目录预览：所选保存位置 + 从仓库地址推导出的项目名。
  const cloneTargetPreview = useMemo(() => {
    const parentPath = cloneParentPath.trim();
    const repoName = deriveRepoNameFromUrl(cloneRepoUrl);
    if (!parentPath || !repoName) {
      return "";
    }
    return joinCloneTargetPath(parentPath, repoName);
  }, [cloneParentPath, cloneRepoUrl]);

  // 弹窗展示的进度：来自弹窗发起的那次克隆任务（关闭弹窗后任务仍在
  // 占位条目里继续，这里只是保持同一份数据源）。
  const activeCloneTask = useMemo(
    () =>
      cloneTasks.find((task) => task.streamId === activeCloneStreamId) ?? null,
    [activeCloneStreamId, cloneTasks],
  );

  const resetAddMenu = (): void => {
    setAddDirectoryMode("");
    setIsAddMenuOpen(false);
  };

  const openAddMenu = (): void => {
    setDirectoryError(null);
    setAddDirectoryMode("");
    setIsAddMenuOpen(true);
  };

  const closeAddMenu = (): void => {
    setIsAddMenuOpen(false);
    setAddDirectoryMode("");
  };

  const returnToAddMenu = (): void => {
    setDirectoryError(null);
    setIsAddMenuOpen(true);
  };

  const handleAddDirectoryModeSelect = (mode: WorkspaceDirectoryKind): void => {
    setAddDirectoryMode(mode);
    setDirectoryError(null);
    setIsAddMenuOpen(false);

    if (mode === "ssh") {
      onOpenSshWizard?.();
      return;
    }

    setSelectedLocalPath("");
    setIsAddLocalDialogOpen(true);
  };

  const handleSelectLocalDirectory = async (): Promise<void> => {
    setDirectoryError(null);
    try {
      const selectedPath = await window.snow.selectWorkspaceDirectory(
        t("sidebar.selectLocalDirectoryTitle", {
          defaultValue: "Select local workspace directory",
        }),
      );
      if (selectedPath) setSelectedLocalPath(selectedPath);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.selectLocalDirectoryError", {
              defaultValue: "Failed to select local directory",
            }),
      );
    }
  };

  const handleAddLocalDirectoryCancel = (): void => {
    // 取消时返回上一级（选择添加方式），而不是直接关闭整个模态框
    setIsAddLocalDialogOpen(false);
    setSelectedLocalPath("");
    setIsDraggingLocalDirectory(false);
    returnToAddMenu();
  };

  const handleLocalDirectoryDrop = async (files: File[]): Promise<void> => {
    setDirectoryError(null);

    if (files.length !== 1) {
      setDirectoryError(
        t("sidebar.localDirectoryDropSingleError", {
          defaultValue: "Drop exactly one folder.",
        }),
      );
      return;
    }

    try {
      const entries = await window.snow.resolveDroppedFiles(files);
      const entry = entries[0];
      if (!entry?.isDirectory) {
        setDirectoryError(
          t("sidebar.localDirectoryDropTypeError", {
            defaultValue: "Only folders can be added here.",
          }),
        );
        return;
      }
      setSelectedLocalPath(entry.path);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.selectLocalDirectoryError", {
              defaultValue: "Failed to select local directory",
            }),
      );
    }
  };

  const handleAddLocalDirectoryConfirm = async (): Promise<void> => {
    const selectedPath = selectedLocalPath.trim();
    if (!selectedPath) return;

    const didSave = await persistWorkspaceDirectory(
      toWorkspaceDirectoryInput(
        selectedPath,
        "local",
        workspaceDirectories.length,
      ),
    );
    if (didSave) {
      setIsAddLocalDialogOpen(false);
      setSelectedLocalPath("");
      resetAddMenu();
    }
  };

  const handleCreateProjectModeOpen = (): void => {
    resetAddMenu();
    setDirectoryError(null);
    setProjectNameInput("");
    setIsCreateProjectOpen(true);
  };

  const handleCreateProjectCancel = (): void => {
    // 取消时返回上一级（选择添加方式），而不是直接关闭整个模态框
    setIsCreateProjectOpen(false);
    setProjectNameInput("");
    returnToAddMenu();
  };

  // 创建项目：先让用户选择保存目录（父目录），再交由主进程/Rust 创建文件夹
  // 并作为活动项目写入工作区目录列表。
  const handleCreateProjectConfirm = async (): Promise<void> => {
    const projectName = projectNameInput.trim();
    if (!projectName) {
      return;
    }

    setIsSavingDirectory(true);
    setDirectoryError(null);

    try {
      const parentPath = await window.snow.selectWorkspaceDirectory(
        t("sidebar.selectCreateProjectParentTitle", {
          defaultValue: "Choose a folder to save the new project",
        }),
      );

      if (!parentPath) {
        return;
      }

      const directories = await window.snow.createWorkspaceProject(
        parentPath,
        projectName,
      );
      setWorkspaceDirectories(directories);
      setIsCreateProjectOpen(false);
      setProjectNameInput("");
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.createProjectError", {
              defaultValue: "Failed to create project",
            }),
      );
    } finally {
      setIsSavingDirectory(false);
    }
  };

  const removeCloneTask = (streamId: string): void => {
    if (!streamId) {
      return;
    }
    setCloneTasks((prev) => prev.filter((task) => task.streamId !== streamId));
  };

  const handleCloneRepoModeOpen = (): void => {
    resetAddMenu();
    setDirectoryError(null);
    setCloneError(null);
    // 已有克隆在跑时保留地址与保存位置：重新打开弹窗等于查看该任务状态。
    if (!isCloneSubmitting) {
      setCloneRepoUrl("");
      setCloneParentPath("");
    }
    setIsCloneRepoOpen(true);
  };

  /**
   * 关闭克隆弹窗：空闲时=取消（回到添加方式菜单）；克隆中=让克隆在后台
   * 继续（不中断 git 进程，进度改由侧边栏项目区的占位条目承载）。
   */
  const handleCloneRepoCancel = (): void => {
    setIsCloneRepoOpen(false);
    setCloneError(null);
    setDirectoryError(null);

    if (isCloneSubmitting) {
      return;
    }

    setCloneRepoUrl("");
    setCloneParentPath("");
    returnToAddMenu();
  };

  const handleSelectCloneDirectory = async (): Promise<void> => {
    setDirectoryError(null);
    try {
      const selectedPath = await window.snow.selectWorkspaceDirectory(
        t("sidebar.selectCloneDirectoryTitle", {
          defaultValue: "Choose a folder to save the repository",
        }),
      );
      if (selectedPath) setCloneParentPath(selectedPath);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.selectLocalDirectoryError", {
              defaultValue: "Failed to select local directory",
            }),
      );
    }
  };

  /**
   * 克隆结束后（失败或中止）的收尾：中止是用户主动行为，不提示错误、
   * 直接移除占位条目；失败则保留占位条目（带原因 + 移除按钮），弹窗
   * 还开着时同时在弹窗内提示。
   */
  const handleCloneFailure = (streamId: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : "";
    if (isCloneCanceledError(message)) {
      removeCloneTask(streamId);
      return;
    }

    const failureMessage =
      message ||
      t("sidebar.cloneRepositoryError", {
        defaultValue: "Failed to clone repository",
      });

    setCloneTasks((prev) =>
      prev.map((task) =>
        task.streamId === streamId
          ? { ...task, status: "failed", error: failureMessage }
          : task,
      ),
    );

    if (isCloneRepoOpenRef.current) {
      setCloneError(failureMessage);
    }
  };

  // 克隆仓库：URL 与保存位置就绪后，由 Rust 后端以异步子进程执行
  // git clone（不阻塞主进程、不锁侧边栏），按 git 惯例在所选目录下以
  // 项目名新建子目录，进度实时上报。克隆过程中弹窗可以关闭，克隆继续
  // 在后台进行（占位条目展示进度与取消入口）；成功后主进程才把实际
  // 克隆目录登记为活动本地工作区目录并返回最新目录列表。
  const handleCloneRepoConfirm = async (): Promise<void> => {
    const repoUrl = cloneRepoUrl.trim();
    const parentPath = cloneParentPath.trim();
    if (!repoUrl || !parentPath || isCloneSubmitting) {
      return;
    }

    const repoName = deriveRepoNameFromUrl(repoUrl) || repoUrl;
    const targetPath = joinCloneTargetPath(parentPath, repoName);
    let streamId = "";

    setIsCloneSubmitting(true);
    setCloneError(null);
    setDirectoryError(null);
    // 上一轮失败留下的占位条目：开新一轮克隆时清掉，避免堆积。
    setCloneTasks((prev) => prev.filter((task) => task.status !== "failed"));

    try {
      const directories = await window.snow.cloneWorkspaceRepository(
        repoUrl,
        parentPath,
        (chunk) => {
          if (!streamId) {
            return;
          }
          setCloneTasks((prev) =>
            prev.map((task) =>
              task.streamId === streamId ? { ...task, progress: chunk } : task,
            ),
          );
        },
        (nextStreamId) => {
          streamId = nextStreamId;
          setActiveCloneStreamId(nextStreamId);
          setCloneTasks((prev) => [
            ...prev,
            {
              streamId: nextStreamId,
              repoName,
              targetPath,
              progress: null,
              status: "cloning",
              error: null,
            },
          ]);
        },
      );
      setWorkspaceDirectories(directories);
      setIsCloneRepoOpen(false);
      setCloneRepoUrl("");
      setCloneParentPath("");
      removeCloneTask(streamId);
    } catch (error) {
      handleCloneFailure(streamId, error);
    } finally {
      setIsCloneSubmitting(false);
      setIsCloneAborting(false);
      setActiveCloneStreamId(null);
    }
  };

  /** 中止克隆任务：Rust 侧杀掉整棵 git 进程树并清理半成品目标目录。 */
  const handleAbortCloneTask = async (streamId: string): Promise<void> => {
    if (!streamId || isCloneAborting) {
      return;
    }

    setIsCloneAborting(true);
    setCloneTasks((prev) =>
      prev.map((task) =>
        task.streamId === streamId ? { ...task, status: "aborting" } : task,
      ),
    );

    try {
      const didCancel =
        await window.snow.cancelCloneWorkspaceRepository(streamId);
      if (!didCancel) {
        // 任务已经结束（完成/失败/已中止）：克隆自身的收尾逻辑会更新
        // 占位条目，这里只恢复按钮状态。
        setIsCloneAborting(false);
      }
    } catch (error) {
      setIsCloneAborting(false);
      setCloneTasks((prev) =>
        prev.map((task) =>
          task.streamId === streamId ? { ...task, status: "cloning" } : task,
        ),
      );
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.cloneAbortError", {
              defaultValue: "Failed to abort the clone",
            }),
      );
    }
  };

  /** 中止弹窗当前这次克隆（弹窗内的「中止克隆」按钮）。 */
  const handleAbortActiveClone = (): void => {
    if (!activeCloneStreamId) {
      return;
    }
    void handleAbortCloneTask(activeCloneStreamId);
  };

  // ===== Project collections（项目合集） =====

  const handleCreateCollectionModeOpen = (): void => {
    resetAddMenu();
    setDirectoryError(null);
    setCreateCollectionName("");
    setIsCreateCollectionOpen(true);
  };

  const handleCreateCollectionCancel = (): void => {
    setIsCreateCollectionOpen(false);
    setCreateCollectionName("");
    returnToAddMenu();
  };

  const handleCreateCollectionConfirm = async (): Promise<void> => {
    const didCreate = await createCollection(createCollectionName);
    if (didCreate) {
      setIsCreateCollectionOpen(false);
      setCreateCollectionName("");
    }
  };

  const handleRenameCollectionOpen = (
    collection: ProjectCollectionRecord,
  ): void => {
    setDirectoryError(null);
    setEditingCollection(collection);
    setRenameCollectionName(collection.name);
    setIsRenameCollectionOpen(true);
  };

  const handleRenameCollectionCancel = (): void => {
    setIsRenameCollectionOpen(false);
    setEditingCollection(null);
    setRenameCollectionName("");
    setDirectoryError(null);
  };

  const handleRenameCollectionConfirm = async (): Promise<void> => {
    if (!editingCollection) {
      return;
    }

    const didRename = await renameCollection(
      editingCollection.collectionId,
      renameCollectionName,
    );
    if (didRename) {
      setIsRenameCollectionOpen(false);
      setEditingCollection(null);
      setRenameCollectionName("");
    }
  };

  return {
    isAddMenuOpen,
    openAddMenu,
    closeAddMenu,
    handleAddDirectoryModeSelect,
    isCreateProjectOpen,
    projectNameInput,
    setProjectNameInput,
    handleCreateProjectModeOpen,
    handleCreateProjectCancel,
    handleCreateProjectConfirm,
    isAddLocalDialogOpen,
    selectedLocalPath,
    isDraggingLocalDirectory,
    setIsDraggingLocalDirectory,
    handleSelectLocalDirectory,
    handleAddLocalDirectoryCancel,
    handleLocalDirectoryDrop,
    handleAddLocalDirectoryConfirm,
    isCloneRepoOpen,
    cloneRepoUrl,
    setCloneRepoUrl,
    cloneParentPath,
    cloneTargetPreview,
    cloneTasks,
    cloneProgress: activeCloneTask?.progress ?? null,
    cloneError,
    isCloneSubmitting,
    isCloneAborting,
    handleCloneRepoModeOpen,
    handleCloneRepoCancel,
    handleSelectCloneDirectory,
    handleCloneRepoConfirm,
    handleAbortActiveClone,
    handleAbortCloneTask,
    handleRemoveCloneTask: removeCloneTask,
    isCreateCollectionOpen,
    createCollectionName,
    setCreateCollectionName,
    handleCreateCollectionModeOpen,
    handleCreateCollectionCancel,
    handleCreateCollectionConfirm,
    isRenameCollectionOpen,
    renameCollectionName,
    setRenameCollectionName,
    handleRenameCollectionOpen,
    handleRenameCollectionCancel,
    handleRenameCollectionConfirm,
  };
}
