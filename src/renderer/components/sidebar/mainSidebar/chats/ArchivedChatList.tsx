import { ListChecks, Loader2, Search, X } from "lucide-react";
import type { RefObject } from "react";

import type { ChatConversationRecord } from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import { ArchivedChatItem } from "../ArchivedChatItem";
import { ChatListFooter } from "./ChatListFooter";
import {
  ChatMultiSelectBar,
  type ChatMultiSelectAction,
} from "./ChatMultiSelectBar";

type ArchivedChatListProps = {
  directoryId: string;
  isSwitchingDirectory: boolean;
  isArchivedLoading: boolean;
  isArchivedLoadingMore: boolean;
  archivedError: string | null;
  archivedConversations: ChatConversationRecord[];
  hasMoreArchived: boolean;
  loadMoreRef: RefObject<HTMLDivElement | null>;
  archivedSearchInput: string;
  onChangeArchivedSearch: (value: string) => void;
  isArchivedMultiSelect: boolean;
  archivedSelectedIds: Set<string>;
  restoringIds: Set<string>;
  deletingArchivedIds: Set<string>;
  onExitMultiSelect: () => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onBatchRestore: () => void;
  onBatchDelete: () => void;
  onEnterMultiSelect: () => void;
  onToggleSelect: (conversationId: string) => void;
  onRestore: (conversation: ChatConversationRecord) => void;
  onDelete: (conversation: ChatConversationRecord) => void;
};

export function ArchivedChatList({
  directoryId,
  isSwitchingDirectory,
  isArchivedLoading,
  isArchivedLoadingMore,
  archivedError,
  archivedConversations,
  hasMoreArchived,
  loadMoreRef,
  archivedSearchInput,
  onChangeArchivedSearch,
  isArchivedMultiSelect,
  archivedSelectedIds,
  restoringIds,
  deletingArchivedIds,
  onExitMultiSelect,
  onSelectAll,
  onDeselectAll,
  onBatchRestore,
  onBatchDelete,
  onEnterMultiSelect,
  onToggleSelect,
  onRestore,
  onDelete,
}: ArchivedChatListProps): React.JSX.Element {
  const { t } = useI18n();
  const isRestoring = restoringIds.size > 0;
  const isDeleting = deletingArchivedIds.size > 0;
  const allSelected =
    archivedSelectedIds.size === archivedConversations.length &&
    archivedConversations.length > 0;
  const isBusy = isDeleting || isRestoring;
  const hasKeyword = archivedSearchInput.trim().length > 0;
  // 无结果时仍保留搜索框，便于清空关键词
  const showSearchRow =
    !isArchivedMultiSelect && (archivedConversations.length > 0 || hasKeyword);

  const archivedActions: ChatMultiSelectAction[] = [
    {
      key: "restore",
      label: isRestoring
        ? t("sidebar.chatMultiSelectRestoring", {
            defaultValue: "Restoring...",
          })
        : t("sidebar.archivedChatMultiSelectRestore", {
            defaultValue: "Restore selected",
          }),
      icon: isRestoring ? "spinner" : "restore",
      disabled: isRestoring || archivedSelectedIds.size === 0,
      onClick: onBatchRestore,
    },
    {
      key: "delete",
      label: t("sidebar.archivedChatMultiSelectDelete", {
        defaultValue: "Delete selected",
      }),
      icon: isDeleting ? "spinner" : "trash",
      disabled: isDeleting || isRestoring || archivedSelectedIds.size === 0,
      danger: true,
      onClick: onBatchDelete,
    },
  ];

  return (
    <>
      {/* 归档模式：归档会话不允许直接打开使用，必须还原后才能继续对话 */}
      {isArchivedMultiSelect ? (
        <ChatMultiSelectBar
          selectedCount={archivedSelectedIds.size}
          allSelected={allSelected}
          isExitDisabled={isBusy}
          selectAllDisabled={isBusy}
          onExit={onExitMultiSelect}
          onToggleSelectAll={allSelected ? onDeselectAll : onSelectAll}
          actions={archivedActions}
        />
      ) : null}
      {showSearchRow ? (
        <div className="archived-search-row">
          <Search
            aria-hidden="true"
            className="archived-search-icon"
            size={13}
            strokeWidth={2}
          />
          <input
            aria-label={t("sidebar.archivedChatsSearchPlaceholder", {
              defaultValue: "Search archived chats",
            })}
            className="archived-search-input"
            onChange={(event) => onChangeArchivedSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && archivedSearchInput !== "") {
                event.preventDefault();
                event.stopPropagation();
                onChangeArchivedSearch("");
              }
            }}
            placeholder={t("sidebar.archivedChatsSearchPlaceholder", {
              defaultValue: "Search archived chats",
            })}
            type="text"
            value={archivedSearchInput}
          />
          {archivedSearchInput !== "" ? (
            <button
              aria-label={t("sidebar.archivedChatsSearchClear", {
                defaultValue: "Clear search",
              })}
              className="archived-search-clear"
              onClick={() => onChangeArchivedSearch("")}
              title={t("sidebar.archivedChatsSearchClear", {
                defaultValue: "Clear search",
              })}
              type="button"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
      {/* 搜索时保留旧列表，避免每次输入整块闪烁 */}
      {isSwitchingDirectory ||
      (isArchivedLoading && archivedConversations.length === 0) ? (
        <span className="empty-text loading">
          <Loader2 className="spin" size={13} />
          {t("sidebar.loadingWorkspaceContent", {
            defaultValue: "Loading workspace content...",
          })}
        </span>
      ) : !directoryId ? (
        <span className="empty-text">
          {t("sidebar.noActiveDirectory", {
            defaultValue: "No active directory",
          })}
        </span>
      ) : archivedError ? (
        <span className="empty-text error">{archivedError}</span>
      ) : archivedConversations.length === 0 ? (
        <span className="empty-text">
          {hasKeyword
            ? t("sidebar.archivedChatsSearchEmpty", {
                defaultValue: "No matching archived chats",
              })
            : t("sidebar.archivedChatsEmpty", {
                defaultValue: "No archived chats",
              })}
        </span>
      ) : (
        <>
          {!isArchivedMultiSelect && (
            <div className="archived-chat-toolbar">
              <span className="archived-chat-toolbar-hint">
                {t("sidebar.archivedChatsHint", {
                  defaultValue: "Restore archived chats to continue using them",
                })}
              </span>
              <button
                type="button"
                className="archived-multi-select-btn"
                onClick={onEnterMultiSelect}
              >
                <ListChecks size={13} />
                <span>
                  {t("sidebar.chatActionMultiSelect", {
                    defaultValue: "Multi-select",
                  })}
                </span>
              </button>
            </div>
          )}
          {archivedConversations.map((conversation) => (
            <ArchivedChatItem
              key={conversation.conversationId}
              conversation={conversation}
              isMultiSelectMode={isArchivedMultiSelect}
              isSelected={archivedSelectedIds.has(conversation.conversationId)}
              isRestoring={restoringIds.has(conversation.conversationId)}
              isDeleting={deletingArchivedIds.has(conversation.conversationId)}
              onToggleSelect={() => onToggleSelect(conversation.conversationId)}
              onRestore={() => onRestore(conversation)}
              onDelete={() => onDelete(conversation)}
            />
          ))}
          <ChatListFooter
            sentinelRef={loadMoreRef}
            hasMore={hasMoreArchived}
            isLoadingMore={isArchivedLoadingMore}
          />
        </>
      )}
    </>
  );
}
