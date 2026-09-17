import { useMemo, useState } from "react";

import type {
  GitCloneProgress,
  ProjectCollectionRecord,
  WorkspaceDirectoryInput,
  WorkspaceDirectoryKind,
  WorkspaceDirectoryRecord,
} from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import {
  deriveRepoNameFromUrl,
  joinCloneTargetPath,
  toWorkspaceDirectoryInput,
} from "./directoryInputs";

type AddDirectoryMode = "" | WorkspaceDirectoryKind;

type UseProjectAddFlowOptions = {
  workspaceDirectories: WorkspaceDirectoryRecord[];
  setWorkspaceDirectories: (directories: WorkspaceDirectoryRecord[]) => void;
  persistWorkspaceDirectory: (item: WorkspaceDirectoryInput) => Promise<boolean>;
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
  const [cloneProgress, setCloneProgress] = useState<GitCloneProgress | null>(
    null,
  );
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

  const handleCloneRepoModeOpen = (): void => {
    resetAddMenu();
    setDirectoryError(null);
    setCloneRepoUrl("");
    setCloneParentPath("");
    setCloneProgress(null);
    setIsCloneRepoOpen(true);
  };

  const handleCloneRepoCancel = (): void => {
    setIsCloneRepoOpen(false);
    setCloneRepoUrl("");
    setCloneParentPath("");
    setCloneProgress(null);
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

  // 克隆仓库：URL 与保存位置就绪后，由 Rust 后端以异步子进程执行
  // git clone（不阻塞主进程），按 git 惯例在所选目录下以项目名新建
  // 子目录，进度实时展示；成功后主进程把实际克隆目录登记为活动
  // 本地工作区目录并返回最新目录列表。
  const handleCloneRepoConfirm = async (): Promise<void> => {
    const repoUrl = cloneRepoUrl.trim();
    const parentPath = cloneParentPath.trim();
    if (!repoUrl || !parentPath) {
      return;
    }

    setIsSavingDirectory(true);
    setDirectoryError(null);
    setCloneProgress(null);

    try {
      const directories = await window.snow.cloneWorkspaceRepository(
        repoUrl,
        parentPath,
        setCloneProgress,
      );
      setWorkspaceDirectories(directories);
      setIsCloneRepoOpen(false);
      setCloneRepoUrl("");
      setCloneParentPath("");
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.cloneRepositoryError", {
              defaultValue: "Failed to clone repository",
            }),
      );
    } finally {
      setIsSavingDirectory(false);
      setCloneProgress(null);
    }
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
    cloneProgress,
    handleCloneRepoModeOpen,
    handleCloneRepoCancel,
    handleSelectCloneDirectory,
    handleCloneRepoConfirm,
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