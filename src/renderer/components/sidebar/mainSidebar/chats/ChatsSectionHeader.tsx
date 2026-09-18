import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FolderDown,
  Loader2,
} from "lucide-react";
import type { RefObject } from "react";

import { useI18n } from "../../../../i18n";

type ChatsSectionHeaderProps = {
  headerRef: RefObject<HTMLDivElement | null>;
  isCollapsed: boolean;
  isArchiveMode: boolean;
  archivedTotal: number;
  isImportingConversations: boolean;
  onToggleCollapsed: () => void;
  onToggleArchiveMode: () => void;
  onImportConversations: () => void;
};

export function ChatsSectionHeader({
  headerRef,
  isCollapsed,
  isArchiveMode,
  archivedTotal,
  isImportingConversations,
  onToggleCollapsed,
  onToggleArchiveMode,
  onImportConversations,
}: ChatsSectionHeaderProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="section-header" ref={headerRef}>
      <button
        type="button"
        aria-expanded={!isCollapsed}
        className="section-toggle-btn chats-section-toggle"
        onClick={onToggleCollapsed}
        title={t("sidebar.chatToggleCollapse", {
          defaultValue: "Collapse chats",
        })}
      >
        <ChevronRight
          className={isCollapsed ? "" : "section-toggle-chevron--open"}
          size={12}
        />
        <span className="section-title">
          {isArchiveMode
            ? t("sidebar.archivedChats", { defaultValue: "Archived" })
            : t("sidebar.chats", { defaultValue: "Chats" })}
        </span>
        {isArchiveMode && archivedTotal > 0 ? (
          <span className="chats-archive-count">{archivedTotal}</span>
        ) : null}
      </button>
      <div className="section-actions">
        <button
          type="button"
          aria-label={t("sidebar.chatImportConversations", {
            defaultValue: "Import conversations",
          })}
          className="icon-btn ghost chats-import-toggle"
          disabled={isImportingConversations}
          onClick={onImportConversations}
          title={t("sidebar.chatImportConversations", {
            defaultValue: "Import conversations",
          })}
        >
          {isImportingConversations ? (
            <Loader2 className="spin" size={14} />
          ) : (
            <FolderDown size={14} />
          )}
        </button>
        <button
          type="button"
          aria-pressed={isArchiveMode}
          aria-label={
            isArchiveMode
              ? t("sidebar.archivedChatsToggleBack", {
                  defaultValue: "Back to chats",
                })
              : t("sidebar.archivedChatsToggle", {
                  defaultValue: "View archived chats",
                })
          }
          className={`icon-btn ghost chats-archive-toggle${
            isArchiveMode ? " active" : ""
          }`}
          onClick={onToggleArchiveMode}
          title={
            isArchiveMode
              ? t("sidebar.archivedChatsToggleBack", {
                  defaultValue: "Back to chats",
                })
              : t("sidebar.archivedChatsToggle", {
                  defaultValue: "View archived chats",
                })
          }
        >
          {isArchiveMode ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        </button>
      </div>
    </div>
  );
}
