import {
  ChevronRight,
  FolderPlus,
  Library,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { RefObject } from "react";

import type {
  ProjectCollectionRecord,
  WorkspaceDirectoryRecord,
} from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import { ContextMenu } from "../../../common/ContextMenu";
import { Tooltip } from "../../../common/Tooltip";
import { SidebarCollapse } from "../SidebarCollapse";
import type { DirectoryDragDropController } from "../projects/useDirectoryDragDrop";
import { TreeProjectNode } from "./TreeProjectNode";

type TreeCollectionNodeProps = {
  collection: ProjectCollectionRecord;
  memberDirectories: WorkspaceDirectoryRecord[];
  displayNames: Map<string, string>;
  activeDirectoryId?: string;
  activeConversationId?: string;
  activeSessionDirectoryIds?: Set<string>;
  notificationCountByDirectory: Record<string, number>;
  isExpanded: boolean;
  isActionLocked: boolean;
  expandedDirectoryIds: Set<string>;
  dragAndDrop: DirectoryDragDropController;
  sectionListRef: RefObject<HTMLDivElement | null>;
  onToggleCollection: (collectionId: string) => void;
  onAddProjectToCollection: (collection: ProjectCollectionRecord) => void;
  onRenameCollection: (collection: ProjectCollectionRecord) => void;
  onDeleteCollection: (collection: ProjectCollectionRecord) => void;
  onActivateDirectory: (directoryId: string) => void;
  onToggleDirectory: (directoryId: string) => void;
  onDeleteDirectory: (directoryId: string) => void;
  onRenameDirectory: (directoryId: string, newName: string) => Promise<void>;
  onShowDetails?: (directoryId: string) => void;
  onShowRelinkHistory?: (directoryId: string) => void;
  onToggleMemberLinked: (
    collectionId: string,
    directoryId: string,
    linked: boolean,
  ) => void;
  onRemoveFromCollection: (collectionId: string, directoryId: string) => void;
};

export function TreeCollectionNode({
  collection,
  memberDirectories,
  displayNames,
  activeDirectoryId,
  activeConversationId,
  activeSessionDirectoryIds,
  notificationCountByDirectory,
  isExpanded,
  isActionLocked,
  expandedDirectoryIds,
  dragAndDrop,
  sectionListRef,
  onToggleCollection,
  onAddProjectToCollection,
  onRenameCollection,
  onDeleteCollection,
  onActivateDirectory,
  onToggleDirectory,
  onDeleteDirectory,
  onRenameDirectory,
  onShowDetails,
  onShowRelinkHistory,
  onToggleMemberLinked,
  onRemoveFromCollection,
}: TreeCollectionNodeProps): React.JSX.Element {
  const { t } = useI18n();
  const [collectionMenuAnchor, setCollectionMenuAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [hasRenderedMembers, setHasRenderedMembers] = useState(isExpanded);

  useEffect(() => {
    if (isExpanded && !hasRenderedMembers) {
      setHasRenderedMembers(true);
    }
  }, [isExpanded, hasRenderedMembers]);

  const isDragOver =
    dragAndDrop.dragOverCollectionId === collection.collectionId;

  const handleCollectionDragOver = (
    event: React.DragEvent<HTMLDivElement>,
  ): void => {
    if (isActionLocked || !dragAndDrop.draggedDirectoryId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    dragAndDrop.handleCollectionDragOver(collection.collectionId);
  };

  const handleCollectionDrop = (
    event: React.DragEvent<HTMLDivElement>,
  ): void => {
    event.preventDefault();
    const draggedId =
      dragAndDrop.draggedDirectoryId ||
      event.dataTransfer.getData("text/plain") ||
      null;
    if (!draggedId) {
      return;
    }
    dragAndDrop.handleCollectionDrop(collection.collectionId, draggedId);
  };

  // 成员行的插入指示线：按该合集内的成员顺序计算（与列表模式的成员重排一致）
  const getMemberDropSide = (directoryId: string): "top" | "bottom" | null => {
    const draggedId = dragAndDrop.draggedDirectoryId;
    if (!draggedId || dragAndDrop.dragOverDirectoryId !== directoryId) {
      return null;
    }
    if (draggedId === directoryId) {
      return null;
    }
    const memberIds = collection.memberDirectoryIds;
    const sourceIndex = memberIds.indexOf(draggedId);
    const targetIndex = memberIds.indexOf(directoryId);
    if (targetIndex < 0) {
      return null;
    }
    if (sourceIndex < 0) {
      return "top";
    }
    return sourceIndex < targetIndex ? "bottom" : "top";
  };

  return (
    <div className={`tree-collection-node${isExpanded ? " expanded" : ""}`}>
      <div
        className={`project-collection-row${isDragOver ? " drag-over" : ""}`}
        onContextMenu={(event) => {
          event.preventDefault();
          setCollectionMenuAnchor({
            x: event.clientX,
            y: event.clientY,
          });
        }}
        onDragOver={handleCollectionDragOver}
        onDrop={handleCollectionDrop}
      >
        <button
          className="project-collection-toggle"
          disabled={isActionLocked}
          onClick={() => onToggleCollection(collection.collectionId)}
          title={collection.name}
          type="button"
        >
          <ChevronRight
            className={isExpanded ? "project-collection-chevron--open" : ""}
            size={12}
          />
          <Library className="list-icon list-icon--collection" size={15} />
          <span
            aria-hidden="true"
            className="project-collection-dot"
            style={{ background: collection.color }}
          />
          <span className="list-label">{collection.name}</span>
          <span
            className="project-collection-badge"
            title={t("sidebar.collectionMemberCount", {
              values: {
                count: collection.memberDirectoryIds.length,
                linked: collection.linkedDirectoryIds.length,
              },
              defaultValue: "{{count}} project(s)",
            })}
          >
            {collection.memberDirectoryIds.length}
          </span>
        </button>
        <span className="project-collection-actions">
          <Tooltip
            content={t("sidebar.renameCollection", {
              defaultValue: "Rename collection",
            })}
            placement="top"
          >
            <button
              aria-label={t("sidebar.renameCollection", {
                defaultValue: "Rename collection",
              })}
              className="icon-btn ghost"
              disabled={isActionLocked}
              onClick={() => onRenameCollection(collection)}
              type="button"
            >
              <Pencil size={12} />
            </button>
          </Tooltip>
          <Tooltip
            content={t("sidebar.deleteCollection", {
              defaultValue: "Delete collection",
            })}
            placement="top"
          >
            <button
              aria-label={t("sidebar.deleteCollection", {
                defaultValue: "Delete collection",
              })}
              className="icon-btn ghost project-collection-delete-btn"
              disabled={isActionLocked}
              onClick={() => onDeleteCollection(collection)}
              type="button"
            >
              <Trash2 size={12} />
            </button>
          </Tooltip>
        </span>
      </div>
      <SidebarCollapse open={isExpanded}>
        {hasRenderedMembers ? (
          <div className="tree-collection-members">
            {memberDirectories.length === 0 ? (
              <div className="project-collection-empty">
                {t("sidebar.collectionEmptyTree", {
                  defaultValue: "No projects",
                })}
              </div>
            ) : (
              memberDirectories.map((directory) => (
                <TreeProjectNode
                  activeConversationId={activeConversationId}
                  activeDirectoryId={activeDirectoryId}
                  collectionColor={
                    collection.linkedDirectoryIds.includes(
                      directory.directoryId,
                    )
                      ? collection.color
                      : undefined
                  }
                  collectionId={collection.collectionId}
                  collectionName={collection.name}
                  directory={directory}
                  displayName={displayNames.get(directory.directoryId)}
                  dragAndDrop={dragAndDrop}
                  dropIndicatorSide={getMemberDropSide(directory.directoryId)}
                  hasActiveSession={
                    activeSessionDirectoryIds?.has(directory.directoryId) ??
                    false
                  }
                  isActionLocked={isActionLocked}
                  isExpanded={expandedDirectoryIds.has(directory.directoryId)}
                  key={directory.directoryId}
                  memberLinked={collection.linkedDirectoryIds.includes(
                    directory.directoryId,
                  )}
                  notificationCount={
                    notificationCountByDirectory[directory.directoryId] ?? 0
                  }
                  onActivate={onActivateDirectory}
                  onDelete={onDeleteDirectory}
                  onDirectoryDrop={(directoryId, dataTransfer) =>
                    dragAndDrop.handleCollectionMemberDrop(
                      collection.collectionId,
                      directoryId,
                      dataTransfer,
                    )
                  }
                  onRemoveFromCollection={onRemoveFromCollection}
                  onRename={onRenameDirectory}
                  onShowDetails={onShowDetails}
                  onShowRelinkHistory={onShowRelinkHistory}
                  onToggle={onToggleDirectory}
                  onToggleMemberLinked={onToggleMemberLinked}
                  sectionListRef={sectionListRef}
                />
              ))
            )}
          </div>
        ) : null}
      </SidebarCollapse>
      {collectionMenuAnchor ? (
        <ContextMenu
          items={[
            {
              id: "add-project-to-collection",
              label: t("sidebar.addProject", { defaultValue: "Add project" }),
              icon: <FolderPlus size={13} />,
              disabled: isActionLocked,
              onClick: () => {
                setCollectionMenuAnchor(null);
                onAddProjectToCollection(collection);
              },
            },
            {
              id: "rename-collection",
              label: t("sidebar.renameCollection", {
                defaultValue: "Rename collection",
              }),
              icon: <Pencil size={13} />,
              separator: true,
              disabled: isActionLocked,
              onClick: () => {
                setCollectionMenuAnchor(null);
                onRenameCollection(collection);
              },
            },
            {
              id: "delete-collection",
              label: t("sidebar.deleteCollection", {
                defaultValue: "Delete collection",
              }),
              icon: <Trash2 size={13} />,
              danger: true,
              disabled: isActionLocked,
              onClick: () => {
                setCollectionMenuAnchor(null);
                onDeleteCollection(collection);
              },
            },
          ]}
          onClose={() => setCollectionMenuAnchor(null)}
          x={collectionMenuAnchor.x}
          y={collectionMenuAnchor.y}
        />
      ) : null}
    </div>
  );
}
