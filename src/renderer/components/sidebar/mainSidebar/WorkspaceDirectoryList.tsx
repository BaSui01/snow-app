import {
  Folder,
  FolderOpen,
  GripVertical,
  Loader2,
  Server,
} from "lucide-react";
import { useState } from "react";
import type { DragEvent, RefObject } from "react";

import { useI18n } from "../../../i18n";
import type { WorkspaceDirectoryRecord } from "../../../../preload";
import { WorkspaceDirectoryMenu } from "./WorkspaceDirectoryMenu";

type WorkspaceDirectoryListProps = {
  activeDirectoryId?: string;
  directoryListRef: RefObject<HTMLDivElement | null>;
  draggedDirectoryId: string | null;
  dragOverDirectoryId: string | null;
  hasMoreDirectories: boolean;
  isActionLocked: boolean;
  isLoadingDirectories: boolean;
  loadMoreRef: RefObject<HTMLDivElement | null>;
  onActivate: (directoryId: string) => void;
  onDelete: (directoryId: string) => void;
  onDragEnd: () => void;
  onDragOver: (directoryId: string) => void;
  onDragStart: (directoryId: string) => void;
  onDrop: (directoryId: string) => void;
  onShowDetails?: (directoryId: string) => void;
  totalCount: number;
  visibleDirectories: WorkspaceDirectoryRecord[];
  workspaceDirectories: WorkspaceDirectoryRecord[];
};

const getDirectoryIcon = (
  directory: WorkspaceDirectoryRecord
): React.JSX.Element => {
  if (directory.isActive) {
    return <FolderOpen className="list-icon" size={15} />;
  }

  if (directory.kind === "ssh") {
    return <Server className="list-icon" size={15} />;
  }

  return <Folder className="list-icon" size={15} />;
};

export function WorkspaceDirectoryList({
  activeDirectoryId,
  directoryListRef,
  draggedDirectoryId,
  dragOverDirectoryId,
  hasMoreDirectories,
  isActionLocked,
  isLoadingDirectories,
  loadMoreRef,
  onActivate,
  onDelete,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onShowDetails,
  totalCount,
  visibleDirectories,
  workspaceDirectories,
}: WorkspaceDirectoryListProps): React.JSX.Element {
  const { t } = useI18n();
  const [menuOpenDirectoryId, setMenuOpenDirectoryId] = useState<string | null>(
    null
  );

  const handleDragStart = (
    event: DragEvent<HTMLDivElement>,
    directoryId: string
  ): void => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", directoryId);
    onDragStart(directoryId);
  };

  const handleDragOver = (
    event: DragEvent<HTMLDivElement>,
    directoryId: string
  ): void => {
    if (isActionLocked || draggedDirectoryId === directoryId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    onDragOver(directoryId);
  };

  const handleDrop = (
    event: DragEvent<HTMLDivElement>,
    directoryId: string
  ): void => {
    event.preventDefault();
    onDrop(directoryId);
  };

  return (
    <div
      className="section-list workspace-directory-list"
      ref={directoryListRef}
    >
      {isLoadingDirectories ? (
        <span className="empty-text">
          {t("sidebar.loadingDirectories", {
            defaultValue: "Loading directories...",
          })}
        </span>
      ) : workspaceDirectories.length === 0 ? (
        <span className="empty-text">
          {t("sidebar.noDirectories", {
            defaultValue: "No directories",
          })}
        </span>
      ) : (
        <>
          {visibleDirectories.map((directory, index) => {
            const isDragging = draggedDirectoryId === directory.directoryId;
            const isDragOver = dragOverDirectoryId === directory.directoryId;
            const isMenuOpen = menuOpenDirectoryId === directory.directoryId;

            return (
              <div
                className={`workspace-directory-row${
                  isDragging ? " dragging" : ""
                }${isDragOver ? " drag-over" : ""}${
                  isMenuOpen ? " menu-open" : ""
                }`}
                draggable={!isActionLocked}
                key={directory.directoryId}
                onDragEnd={onDragEnd}
                onDragOver={(event) =>
                  handleDragOver(event, directory.directoryId)
                }
                onDragStart={(event) =>
                  handleDragStart(event, directory.directoryId)
                }
                onDrop={(event) => handleDrop(event, directory.directoryId)}
              >
                <button
                  className={`list-item${
                    directory.directoryId === activeDirectoryId ? " active" : ""
                  }`}
                  disabled={isActionLocked}
                  onClick={() => onActivate(directory.directoryId)}
                  onDoubleClick={() => onShowDetails?.(directory.directoryId)}
                  title={directory.path}
                  type="button"
                >
                  <span
                    className="workspace-directory-guide"
                    aria-hidden="true"
                  >
                    <span className="workspace-directory-guide-dot" />
                  </span>
                  <span
                    aria-label={t("sidebar.dragDirectory", {
                      defaultValue: "Drag to reorder",
                    })}
                    className="workspace-directory-drag-handle"
                    role="img"
                  >
                    <GripVertical size={13} />
                  </span>
                  {getDirectoryIcon(directory)}
                  <span className="list-label">{directory.name}</span>
                  <span className="list-meta">
                    {directory.kind === "ssh"
                      ? t("sidebar.directoryKindSsh", {
                          defaultValue: "SSH",
                        })
                      : t("sidebar.directoryKindLocal", {
                          defaultValue: "Local",
                        })}
                  </span>
                  <span className="workspace-directory-index">
                    {index + 1}/{totalCount}
                  </span>
                </button>
                <WorkspaceDirectoryMenu
                  canDelete={directory.source !== "builtin"}
                  directoryPath={directory.path}
                  disabled={isActionLocked}
                  kind={directory.kind}
                  onDelete={() => onDelete(directory.directoryId)}
                  onOpenChange={(isOpen) =>
                    setMenuOpenDirectoryId(
                      isOpen ? directory.directoryId : null
                    )
                  }
                  onShowDetails={
                    onShowDetails
                      ? () => onShowDetails(directory.directoryId)
                      : undefined
                  }
                />
              </div>
            );
          })}
          {hasMoreDirectories ? (
            <div
              aria-hidden="true"
              className="workspace-directory-load-more"
              ref={loadMoreRef}
            >
              <Loader2 className="spin" size={13} />
              <span>
                {t("sidebar.loadingMoreDirectories", {
                  defaultValue: "Loading more...",
                })}
              </span>
            </div>
          ) : (
            <div className="workspace-directory-end-line">
              <span>
                {t("sidebar.allDirectoriesLoaded", {
                  defaultValue: "All directories loaded",
                })}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
