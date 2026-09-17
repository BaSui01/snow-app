import { ChevronRight, Loader2, Plus } from "lucide-react";
import { useMemo } from "react";

import { useI18n } from "../../../i18n";
import type {
  ProjectCollectionRecord,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { RelinkDirectoryDialog } from "./RelinkDirectoryDialog";
import { RelinkHistoryDialog } from "./RelinkHistoryDialog";
import { SidebarCollapse } from "./SidebarCollapse";
import { WorkspaceDirectoryList } from "./WorkspaceDirectoryList";
import { AddDirectoryMenuDialog } from "./projects/dialogs/AddDirectoryMenuDialog";
import { AddLocalDirectoryDialog } from "./projects/dialogs/AddLocalDirectoryDialog";
import { CloneRepositoryDialog } from "./projects/dialogs/CloneRepositoryDialog";
import { CreateCollectionDialog } from "./projects/dialogs/CreateCollectionDialog";
import { CreateProjectDialog } from "./projects/dialogs/CreateProjectDialog";
import { RenameCollectionDialog } from "./projects/dialogs/RenameCollectionDialog";
import { useDirectoryDragDrop } from "./projects/useDirectoryDragDrop";
import { useDirectoryPagination } from "./projects/useDirectoryPagination";
import { useProjectAddFlow } from "./projects/useProjectAddFlow";
import { useProjectCollections } from "./projects/useProjectCollections";
import { useProjectsSectionLayout } from "./projects/useProjectsSectionLayout";
import { useWorkspaceDirectories } from "./projects/useWorkspaceDirectories";
import type { CrossProjectNotificationGroup } from "./useCrossProjectNotifications";

type ProjectsSectionProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  activeSessionDirectoryIds?: Set<string>;
  /** 跨项目通知（其他项目的运行中/需关注/已完成会话分组），用于项目条目徽标 */
  notificationGroups?: CrossProjectNotificationGroup[];
  onActiveDirectoryChange?: (
    directory: WorkspaceDirectoryRecord | null,
  ) => void;
  onSwitchingDirectoryChange: (isSwitchingDirectory: boolean) => void;
  onSwitchContent?: (content: "main" | "explorer") => void;
  onSwitchToExplorer?: (directoryId: string) => void;
  onOpenSshWizard?: () => void;
  /** 会话区域是否已收起：收起时项目列表撑满剩余高度 */
  isChatsCollapsed: boolean;
};

export function ProjectsSection({
  activeDirectory: externalActiveDirectory,
  activeSessionDirectoryIds,
  notificationGroups,
  onActiveDirectoryChange,
  onSwitchingDirectoryChange,
  onSwitchToExplorer,
  onOpenSshWizard,
  isChatsCollapsed,
}: ProjectsSectionProps): React.JSX.Element {
  const { t } = useI18n();

  const directories = useWorkspaceDirectories({
    externalActiveDirectory,
    onActiveDirectoryChange,
    onSwitchingDirectoryChange,
  });
  const {
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
  } = directories;

  const collectionsApi = useProjectCollections({
    setDirectoryError,
    setIsSavingDirectory,
  });
  const {
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
  } = collectionsApi;

  const addFlow = useProjectAddFlow({
    workspaceDirectories,
    setWorkspaceDirectories,
    persistWorkspaceDirectory,
    createCollection,
    renameCollection,
    setIsSavingDirectory,
    setDirectoryError,
    onOpenSshWizard,
  });

  // 顶层（合集外）可见项目 = 全部项目 - 已入合集项目
  const topLevelDirectories = useMemo(
    () =>
      workspaceDirectories.filter(
        (directory) => !collectionMemberIds.has(directory.directoryId),
      ),
    [collectionMemberIds, workspaceDirectories],
  );

  const layout = useProjectsSectionLayout({
    isChatsCollapsed,
    workspaceDirectories,
    activeDirectory,
    isActionLocked:
      isSavingDirectory || isReorderingDirectories || isSwitchingDirectory,
    onActivateDirectory: (directoryId) => {
      void handleActivateDirectory(directoryId);
    },
    onCollapseChange: addFlow.closeAddMenu,
  });
  const { sectionRef, isProjectsCollapsed, toggleProjectsCollapsed } = layout;

  const pagination = useDirectoryPagination({
    topLevelDirectories,
    isProjectsCollapsed,
    isChatsCollapsed,
  });
  const {
    directoryListRef,
    directoryLoadMoreRef,
    visibleDirectories,
    hasMoreDirectories,
  } = pagination;

  const dragAndDrop = useDirectoryDragDrop({
    workspaceDirectories,
    setWorkspaceDirectories,
    collections,
    setCollections,
    collectionMemberIds,
    setIsSavingDirectory,
    setDirectoryError,
    persistWorkspaceDirectoryOrder,
  });

  // 各项目通知计数：directoryId → 通知会话数（需关注/运行中/已完成）。
  // 当前项目的动态由对话列表展示，不参与徽标（hook 已排除）。
  const notificationCountByDirectory = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const group of notificationGroups ?? []) {
      counts[group.directoryId] = group.notifications.length;
    }
    return counts;
  }, [notificationGroups]);

  const handleRelinked = (): void => {
    setRelinkTarget(null);
    setDirectoryError(null);
    void loadWorkspaceDirectories();
    void loadProjectCollections();
  };

  const handleRelinkUndone = (): void => {
    void loadWorkspaceDirectories();
    void loadProjectCollections();
  };

  const handleShowDetails = (directoryId: string): void => {
    const directory = workspaceDirectories.find(
      (d) => d.directoryId === directoryId,
    );

    if (!directory) {
      return;
    }

    onSwitchToExplorer?.(directory.directoryId);
  };

  const isDialogOpen =
    addFlow.isCreateProjectOpen ||
    addFlow.isAddLocalDialogOpen ||
    addFlow.isCloneRepoOpen ||
    addFlow.isCreateCollectionOpen ||
    addFlow.isRenameCollectionOpen;

  return (
    <div
      className={`sidebar-section projects-section${
        isProjectsCollapsed ? " collapsed" : ""
      }${isChatsCollapsed ? " chats-collapsed" : ""}`}
      ref={sectionRef}
    >
      <div className="section-header">
        <button
          aria-expanded={!isProjectsCollapsed}
          className="section-toggle-btn"
          onClick={toggleProjectsCollapsed}
          type="button"
        >
          <ChevronRight
            className={
              isProjectsCollapsed ? "" : "section-toggle-chevron--open"
            }
            size={12}
          />
          <span className="section-title">
            {t("sidebar.projects", { defaultValue: "Projects" })}
          </span>
        </button>
        <div className="section-actions">
          {isLoadingDirectories || isSavingDirectory ? (
            <Loader2 className="spin" size={14} />
          ) : (
            <button
              aria-expanded={addFlow.isAddMenuOpen}
              aria-haspopup="dialog"
              aria-label={t("sidebar.addDirectoryScheme", {
                defaultValue: "Add directory",
              })}
              className="icon-btn ghost"
              onClick={addFlow.openAddMenu}
              type="button"
            >
              <Plus size={14} />
            </button>
          )}
        </div>
      </div>

      <AddDirectoryMenuDialog
        onAddLocalDirectory={() => addFlow.handleAddDirectoryModeSelect("local")}
        onAddSshDirectory={() => addFlow.handleAddDirectoryModeSelect("ssh")}
        onCloneRepository={addFlow.handleCloneRepoModeOpen}
        onClose={addFlow.closeAddMenu}
        onCreateCollection={addFlow.handleCreateCollectionModeOpen}
        onCreateProject={addFlow.handleCreateProjectModeOpen}
        open={addFlow.isAddMenuOpen}
      />

      <CreateProjectDialog
        error={directoryError}
        isSubmitting={isSavingDirectory}
        name={addFlow.projectNameInput}
        onCancel={addFlow.handleCreateProjectCancel}
        onConfirm={() => void addFlow.handleCreateProjectConfirm()}
        onNameChange={addFlow.setProjectNameInput}
        open={addFlow.isCreateProjectOpen}
      />

      <CreateCollectionDialog
        error={directoryError}
        isSubmitting={isSavingDirectory}
        name={addFlow.createCollectionName}
        onCancel={addFlow.handleCreateCollectionCancel}
        onConfirm={() => void addFlow.handleCreateCollectionConfirm()}
        onNameChange={addFlow.setCreateCollectionName}
        open={addFlow.isCreateCollectionOpen}
      />

      <RenameCollectionDialog
        error={directoryError}
        isSubmitting={isSavingDirectory}
        name={addFlow.renameCollectionName}
        onCancel={addFlow.handleRenameCollectionCancel}
        onConfirm={() => void addFlow.handleRenameCollectionConfirm()}
        onNameChange={addFlow.setRenameCollectionName}
        open={addFlow.isRenameCollectionOpen}
      />

      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("sidebar.deleteCollection", {
          defaultValue: "Delete",
        })}
        isConfirming={isSavingDirectory}
        message={t("sidebar.deleteCollectionConfirm", {
          defaultValue:
            "Are you sure you want to delete this collection? Projects inside it are not affected.",
        })}
        onCancel={() => setDeleteCollectionTarget(null)}
        onConfirm={() => void confirmDeleteCollection()}
        open={deleteCollectionTarget !== null}
        title={t("sidebar.deleteCollectionTitle", {
          defaultValue: "Delete collection",
        })}
        variant="danger"
      />

      <AddLocalDirectoryDialog
        error={directoryError}
        isDragging={addFlow.isDraggingLocalDirectory}
        isSubmitting={isSavingDirectory}
        onCancel={addFlow.handleAddLocalDirectoryCancel}
        onConfirm={() => void addFlow.handleAddLocalDirectoryConfirm()}
        onDragStateChange={addFlow.setIsDraggingLocalDirectory}
        onDropFiles={(files) => void addFlow.handleLocalDirectoryDrop(files)}
        onSelectFolder={() => void addFlow.handleSelectLocalDirectory()}
        open={addFlow.isAddLocalDialogOpen}
        path={addFlow.selectedLocalPath}
      />

      <CloneRepositoryDialog
        error={directoryError}
        isSubmitting={isSavingDirectory}
        onCancel={addFlow.handleCloneRepoCancel}
        onConfirm={() => void addFlow.handleCloneRepoConfirm()}
        onRepoUrlChange={addFlow.setCloneRepoUrl}
        onSelectFolder={() => void addFlow.handleSelectCloneDirectory()}
        open={addFlow.isCloneRepoOpen}
        parentPath={addFlow.cloneParentPath}
        progress={addFlow.cloneProgress}
        repoUrl={addFlow.cloneRepoUrl}
        targetPreview={addFlow.cloneTargetPreview}
      />

      <RelinkDirectoryDialog
        directory={relinkTarget}
        onCancel={() => setRelinkTarget(null)}
        onRelinked={handleRelinked}
      />

      <RelinkHistoryDialog
        directory={historyTarget}
        onCancel={() => setHistoryTarget(null)}
        onUndone={handleRelinkUndone}
      />

      <SidebarCollapse open={!isProjectsCollapsed}>
        <div className="workspace-directory-card">
          <span className="workspace-directory-label">
            {t("sidebar.activeDirectory", {
              defaultValue: "Active directory",
            })}
          </span>
          <WorkspaceDirectoryList
            activeDirectoryId={activeDirectory?.directoryId}
            activeSessionDirectoryIds={activeSessionDirectoryIds}
            collections={collections}
            directoryListRef={directoryListRef}
            draggedDirectoryId={dragAndDrop.draggedDirectoryId}
            dragOverCollectionId={dragAndDrop.dragOverCollectionId}
            dragOverDirectoryId={dragAndDrop.dragOverDirectoryId}
            expandedCollectionIds={expandedCollectionIds}
            hasMoreDirectories={hasMoreDirectories}
            isActionLocked={
              isSavingDirectory ||
              isReorderingDirectories ||
              isSwitchingDirectory
            }
            isLoadingDirectories={isLoadingDirectories}
            loadMoreRef={directoryLoadMoreRef}
            notificationCountByDirectory={notificationCountByDirectory}
            onActivate={(directoryId) =>
              void handleActivateDirectory(directoryId)
            }
            onCollectionDragOver={dragAndDrop.handleCollectionDragOver}
            onCollectionDrop={dragAndDrop.handleCollectionDrop}
            onCollectionMemberDrop={dragAndDrop.handleCollectionMemberDrop}
            onDelete={(directoryId) => void handleDeleteDirectory(directoryId)}
            onDeleteCollection={(collection: ProjectCollectionRecord) =>
              setDeleteCollectionTarget(collection)
            }
            onDragEnd={dragAndDrop.handleDirectoryDragEnd}
            onDragOver={dragAndDrop.handleDirectoryDragOver}
            onDragStart={dragAndDrop.handleDirectoryDragStart}
            onDrop={dragAndDrop.handleDirectoryDrop}
            onDropOutside={dragAndDrop.handleDropOutside}
            onRemoveFromCollection={(collectionId, directoryId) =>
              void removeProjectFromCollection(collectionId, directoryId)
            }
            onRename={handleRenameDirectory}
            onRenameCollection={addFlow.handleRenameCollectionOpen}
            onShowDetails={handleShowDetails}
            onShowRelinkHistory={handleShowRelinkHistory}
            onToggleCollection={handleToggleCollectionExpanded}
            totalCount={topLevelDirectories.length}
            visibleDirectories={visibleDirectories}
            workspaceDirectories={workspaceDirectories}
          />
          {directoryError && !isDialogOpen ? (
            <span className="workspace-directory-error">{directoryError}</span>
          ) : null}
        </div>
      </SidebarCollapse>
    </div>
  );
}
