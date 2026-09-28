import { Check, Library, Search, Server, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../../../../i18n";
import { getFileTypeIcon } from "../../../../../utils/fileIcons";
import type {
  ProjectCollectionRecord,
  WorkspaceDirectoryRecord,
} from "../../../../../../preload";
import { FormDialog } from "../../../../common/FormDialog";
import { buildDirectoryDisplayNames } from "../../directoryDisplayName";

type ProjectGridDialogProps = {
  activeDirectoryId?: string;
  collections: ProjectCollectionRecord[];
  isActionLocked: boolean;
  onActivate: (directoryId: string) => void;
  onClose: () => void;
  open: boolean;
  workspaceDirectories: WorkspaceDirectoryRecord[];
};

type ProjectGridGroup = {
  /** null 表示未入合集的顶层项目分组 */
  collection: ProjectCollectionRecord | null;
  directories: WorkspaceDirectoryRecord[];
};

export function ProjectGridDialog({
  activeDirectoryId,
  collections,
  isActionLocked,
  onActivate,
  onClose,
  open,
  workspaceDirectories,
}: ProjectGridDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 每次打开重置搜索词，避免上次的过滤条件残留
  useEffect(() => {
    if (open) {
      setQuery("");
    }
  }, [open]);

  const displayNames = useMemo(
    () => buildDirectoryDisplayNames(workspaceDirectories),
    [workspaceDirectories],
  );

  const groups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const directoryById = new Map(
      workspaceDirectories.map((directory) => [
        directory.directoryId,
        directory,
      ]),
    );

    const matches = (directory: WorkspaceDirectoryRecord): boolean => {
      if (!normalizedQuery) {
        return true;
      }
      const displayName =
        displayNames.get(directory.directoryId) ?? directory.name;
      return (
        directory.name.toLowerCase().includes(normalizedQuery) ||
        displayName.toLowerCase().includes(normalizedQuery) ||
        directory.path.toLowerCase().includes(normalizedQuery)
      );
    };

    const memberIds = new Set<string>();
    const collectionGroups: ProjectGridGroup[] = collections.map(
      (collection) => {
        const directories: WorkspaceDirectoryRecord[] = [];
        for (const directoryId of collection.memberDirectoryIds) {
          memberIds.add(directoryId);
          const directory = directoryById.get(directoryId);
          if (directory && matches(directory)) {
            directories.push(directory);
          }
        }
        return { collection, directories };
      },
    );

    // 顶层项目 = 全部项目 - 已入合集项目，与侧边栏层级保持一致
    const topLevelDirectories = workspaceDirectories.filter(
      (directory) =>
        !memberIds.has(directory.directoryId) && matches(directory),
    );

    const result = collectionGroups.filter(
      (group) => group.directories.length > 0,
    );
    if (topLevelDirectories.length > 0) {
      result.push({ collection: null, directories: topLevelDirectories });
    }
    return result;
  }, [collections, displayNames, query, workspaceDirectories]);

  const matchedCount = groups.reduce(
    (total, group) => total + group.directories.length,
    0,
  );
  const isEmptyWorkspace = workspaceDirectories.length === 0;
  const hasCollectionGroups = groups.some((group) => group.collection !== null);

  const renderCard = (
    directory: WorkspaceDirectoryRecord,
  ): React.JSX.Element => {
    const isActive = directory.directoryId === activeDirectoryId;
    const displayName =
      displayNames.get(directory.directoryId) ?? directory.name;
    return (
      <button
        className={`project-grid-card${isActive ? " active" : ""}`}
        disabled={isActionLocked}
        key={directory.directoryId}
        onClick={() => onActivate(directory.directoryId)}
        title={directory.path}
        type="button"
      >
        <span className="project-grid-card-icon">
          {directory.kind === "ssh" ? (
            <Server className="list-icon list-icon--ssh" size={16} />
          ) : (
            getFileTypeIcon(directory.name, true, directory.isActive, {
              size: 16,
            })
          )}
        </span>
        <span className="project-grid-card-body">
          <span className="project-grid-card-name">{displayName}</span>
          <span className="project-grid-card-path">{directory.path}</span>
        </span>
        {isActive ? (
          <Check className="project-grid-card-check" size={14} />
        ) : null}
      </button>
    );
  };

  return (
    <FormDialog
      cardClassName="project-grid-dialog-card"
      closeLabel={t("sidebar.close", { defaultValue: "Close" })}
      initialFocusRef={searchInputRef}
      onCancel={onClose}
      open={open}
      showFooter={false}
      title={t("sidebar.projects", { defaultValue: "Projects" })}
    >
      <div className="project-grid-dialog">
        <div className="project-grid-search">
          <Search className="project-grid-search-icon" size={14} />
          <input
            aria-label={t("sidebar.searchProjects", {
              defaultValue: "Search projects",
            })}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("sidebar.searchProjects", {
              defaultValue: "Search projects",
            })}
            ref={searchInputRef}
            type="text"
            value={query}
          />
          {query ? (
            <button
              aria-label={t("sidebar.clearProjectSearch", {
                defaultValue: "Clear search",
              })}
              className="project-grid-search-clear"
              onClick={() => {
                setQuery("");
                searchInputRef.current?.focus();
              }}
              title={t("sidebar.clearProjectSearch", {
                defaultValue: "Clear search",
              })}
              type="button"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
        <div className="project-grid-scroll">
          {isEmptyWorkspace || matchedCount === 0 ? (
            <div className="project-grid-empty">
              {isEmptyWorkspace
                ? t("sidebar.noDirectories", {
                    defaultValue: "No directories",
                  })
                : t("sidebar.projectGridNoMatch", {
                    defaultValue: "No matching projects",
                  })}
            </div>
          ) : (
            groups.map((group) => (
              <div
                className="project-grid-group"
                key={group.collection?.collectionId ?? "__top-level__"}
              >
                {group.collection ? (
                  <div className="project-grid-group-header">
                    <Library
                      className="list-icon list-icon--collection"
                      size={13}
                    />
                    <span className="project-grid-group-name">
                      {group.collection.name}
                    </span>
                    <span className="project-grid-group-count">
                      {group.directories.length}
                    </span>
                  </div>
                ) : hasCollectionGroups ? (
                  <div className="project-grid-group-header">
                    <span className="project-grid-group-name">
                      {t("sidebar.projectGridUngrouped", {
                        defaultValue: "Ungrouped projects",
                      })}
                    </span>
                  </div>
                ) : null}
                <div className="project-grid-cards">
                  {group.directories.map(renderCard)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </FormDialog>
  );
}
